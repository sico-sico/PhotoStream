/**
 * The headless benchmark cases.
 *
 * These cover the work the application does that is expensive enough to be worth
 * a number: reading metadata for a photo, scanning a folder, the SQLite cache in
 * front of it, the layout maths that runs on every change of the photo set, and
 * the thumbnail encoder. Everything here runs in plain Node — no window, no IPC
 * — so a case measures one thing and a regression points at one place.
 *
 * The renderer's side of the story (startup, click-to-first-tile) needs a real
 * Electron process and lives in `app.ts`.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readImageMetadata, readFullExif } from '../../src/main/metadata'
import { MetadataCache, type CacheWrite } from '../../src/main/metadata-cache'
import { listImageFiles, scanDirectory } from '../../src/main/scanner'
import { PhotoLibrary } from '../../src/main/ipc'
import { ensureThumbnail, thumbPath, type ThumbRequest } from '../../src/main/thumbnails'
import { computeLayout } from '../../src/shared/layout'
import { sortPhotos } from '../../src/shared/photoStore'
import { cullItems, CULL_MARGIN, MAX_MOUNTED_TILES } from '../../src/shared/cull'
import { applyFilters } from '../../src/shared/filters'
import { minScaleForTiles, minScaleForWall } from '../../src/shared/transform'
import type { Photo } from '../../src/shared/types'
import type { BenchFixtures } from './fixtures'

export type Unit = 'ms' | 'µs' | 'MB'

export interface CaseContext {
  fixtures: BenchFixtures
  /** Scratch directory for anything a case has to create and delete. */
  scratch: string
  /** `lib40000`, built only when a case declares `requires: 'large'`. */
  large: string
}

export interface CaseDefinition {
  id: string
  title: string
  unit: Unit
  /** Operations inside one sample; the reported value is divided by this. */
  per?: number
  samples?: number
  /** Hard ceiling for the median, in `unit`. Enforced even without a baseline. */
  budget?: number
  /**
   * Relative tolerance for this case, overriding the unit default.
   *
   * For cases whose variance comes from outside the program: a cold scan pays
   * for the OS file cache and the virus scanner, and has been measured between
   * 350 and 520 ms with no code change at all.
   */
  tolerance?: number
  /** `large` cases need the 40 000-photo tree, which is built on demand. */
  requires?: 'large'
  setup?: (context: CaseContext) => Promise<void>
  teardown?: (context: CaseContext) => Promise<void>
  run: (context: CaseContext) => Promise<number>
}

export interface CaseResult {
  id: string
  title: string
  unit: Unit
  median: number
  min: number
  max: number
  samples: number
  budget?: number
  tolerance?: number
}

const DEFAULT_SAMPLES = 5

async function elapsed(operation: () => unknown): Promise<number> {
  const start = process.hrtime.bigint()
  await operation()
  return Number(process.hrtime.bigint() - start) / 1e6
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Run `operation` over `items` with `concurrency` in flight.
 *
 * The scan reads 16 photos at a time, so a per-photo benchmark has to as well:
 * timing one `open`+`read`+`close` at a time measures *latency* (about 500 µs on
 * a file the virus scanner inspects) rather than the throughput the scan
 * actually achieves (about 110 µs). Same code, same disk, several times the
 * number — and it would make the benchmark contradict the scan it explains.
 */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<unknown>
): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await operation(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

/** Remove a SQLite database and the bookkeeping files WAL mode leaves behind. */
async function removeDatabase(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(`${path}-wal`, { force: true })
  await rm(`${path}-shm`, { force: true })
}

/**
 * The cached rows of the synthetic library, as `storeMany` takes them.
 *
 * Paths are built under the *fixture* root, not under the `D:\bench` prefix the
 * layout cases use: `snapshot` and `retain` are queries by directory prefix, and
 * rows filed anywhere else would make those cases measure an empty result.
 */
function cachedRows(photos: readonly Photo[], root: string): CacheWrite[] {
  return photos.map((photo) => ({
    path: join(root, ...photo.name.split('/')),
    mtimeMs: photo.mtimeMs,
    sizeBytes: photo.sizeBytes,
    width: photo.width,
    height: photo.height,
    takenAt: photo.takenAt,
    orientation: 1
  }))
}

/**
 * Time one case.
 *
 * A discarded warm-up run comes first: the first pass over a tree pays for the
 * OS file cache, and without it every sample of a 3-sample case is a different
 * measurement. The warm-up is also what makes the cold-scan case honest — it
 * warms the *file* cache while each sample still starts with an empty database.
 */
async function measureCase(
  definition: CaseDefinition,
  context: CaseContext,
  samples: number
): Promise<CaseResult> {
  await definition.setup?.(context)
  try {
    await definition.run(context)
    const values: number[] = []
    for (let index = 0; index < samples; index++) values.push(await definition.run(context))
    const per = definition.per ?? 1
    const scale = definition.unit === 'µs' ? 1000 : 1
    return {
      id: definition.id,
      title: definition.title,
      unit: definition.unit,
      median: (median(values) / per) * scale,
      min: (Math.min(...values) / per) * scale,
      max: (Math.max(...values) / per) * scale,
      samples,
      budget: definition.budget,
      tolerance: definition.tolerance
    }
  } finally {
    await definition.teardown?.(context)
  }
}

export async function runCases(
  definitions: readonly CaseDefinition[],
  context: CaseContext,
  options: { samples?: number; onResult?: (result: CaseResult) => void } = {}
): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  for (const definition of definitions) {
    const samples = options.samples ?? definition.samples ?? DEFAULT_SAMPLES
    const result = await measureCase(definition, context, samples)
    results.push(result)
    options.onResult?.(result)
  }
  return results
}

/**
 * Every headless case, closed over the fixtures.
 *
 * Budgets sit at roughly 2.5× the number measured on the reference machine (see
 * `benchmarks/baseline.json`). Not 1.1×: they exist to catch "an order of
 * magnitude slower" — a lost cache, a per-photo round trip, a parser moved onto
 * the main thread — and a tight budget on wall-clock time only teaches people to
 * ignore the report. Relative regressions against the baseline are the precise
 * check; budgets are the one that travels between machines.
 */
export function headlessCases(fixtures: BenchFixtures): CaseDefinition[] {
  const files = fixtures.samples
  const photos = fixtures.photos40000
  // Filed under the 40 000-photo root, so `snapshot` and `retain` — which query
  // by directory prefix — see them.
  const rows = cachedRows(photos, fixtures.lib40000)

  /** Time `operation` over every file in `paths`, several times over; per file. */
  const perFile = (paths: readonly string[], operation: (path: string) => Promise<unknown>) => {
    // Repeated rounds rather than one pass: eight files over sixteen workers is
    // a single wave, which measures the slowest file rather than the rate.
    const work = Array.from({ length: 8 }, () => paths).flat()
    return async (): Promise<number> => elapsed(() => pool(work, 16, operation))
  }

  /** Repeat one cheap operation inside a sample, so the sample is long enough. */
  const repeated = (times: number, operation: () => unknown) => {
    return async (): Promise<number> =>
      elapsed(async () => {
        for (let index = 0; index < times; index++) await operation()
      })
  }

  /**
   * A database of its own, populated once, for the read-side cache cases.
   *
   * Each case owning its file keeps the suite order-independent: a case that
   * writes has no bearing on one that reads.
   */
  const cacheWithRows = async (context: CaseContext, name: string): Promise<void> => {
    const path = join(context.scratch, name)
    await removeDatabase(path)
    const cache = new MetadataCache(path)
    try {
      cache.storeMany(rows)
    } finally {
      cache.close()
    }
  }

  const thumbCase = (level: 'wall' | 'zoom'): CaseDefinition => ({
    id: `thumb.${level}.12mp`,
    title: `ensureThumbnail, ${level} tier, 12 MP`,
    unit: 'ms',
    budget: level === 'wall' ? 200 : 1200,
    run: async (context) => {
      const request: ThumbRequest = {
        sourcePath: context.fixtures.large,
        // Fixed values: the cache key only has to be unique, not real.
        mtimeMs: 1,
        sizeBytes: 1,
        level,
        sourceWidth: 4000,
        sourceHeight: 3000
      }
      const cacheDir = join(context.scratch, 'thumbs')
      // Every sample must encode, so the file the previous sample wrote has to go.
      await rm(thumbPath(cacheDir, request), { force: true })
      return elapsed(() => ensureThumbnail(cacheDir, request))
    }
  })

  return [
    // ---- Metadata, per photo ------------------------------------------------
    {
      id: 'parse.jpeg-exif',
      title: 'readImageMetadata, JPEG with EXIF',
      unit: 'µs',
      per: files.jpegExif.length * 8,
      budget: 300,
      tolerance: 0.35,
      run: perFile(files.jpegExif, (path) => readImageMetadata(path))
    },
    {
      id: 'parse.jpeg-plain',
      title: 'readImageMetadata, JPEG without EXIF',
      unit: 'µs',
      per: files.jpegPlain.length * 8,
      budget: 300,
      tolerance: 0.35,
      run: perFile(files.jpegPlain, (path) => readImageMetadata(path))
    },
    {
      id: 'parse.png-plain',
      title: 'readImageMetadata, PNG without EXIF',
      unit: 'µs',
      per: files.pngPlain.length * 8,
      budget: 300,
      tolerance: 0.35,
      run: perFile(files.pngPlain, (path) => readImageMetadata(path))
    },
    {
      id: 'parse.jpeg-second-read',
      title: 'readImageMetadata, EXIF past 64 KB',
      unit: 'µs',
      per: files.jpegFat.length * 8,
      budget: 700,
      tolerance: 0.4,
      // The only case that pays for the second, 512 KB read: it is what the
      // container walk exists to avoid paying for on ordinary files.
      run: perFile(files.jpegFat, (path) => readImageMetadata(path))
    },
    {
      id: 'exif.full',
      title: 'readFullExif, JPEG with EXIF',
      unit: 'ms',
      per: 10,
      budget: 3,
      run: repeated(10, () => readFullExif(files.jpegExif[0]))
    },

    // ---- Listing and scanning ----------------------------------------------
    {
      id: 'list.flat-1000',
      title: 'listImageFiles, 1 000 files, no recursion',
      unit: 'ms',
      samples: 7,
      per: 5,
      budget: 8,
      run: repeated(5, () => listImageFiles(fixtures.album1000, false))
    },
    {
      id: 'list.recursive-4000',
      title: 'listImageFiles, 4 000 files, recursive',
      unit: 'ms',
      per: 3,
      budget: 30,
      run: repeated(3, () => listImageFiles(fixtures.lib4000, true))
    },
    {
      id: 'scan.4000.cold',
      title: 'scanDirectory, 4 000 photos, empty cache',
      unit: 'ms',
      samples: 3,
      budget: 1200,
      tolerance: 0.5,
      run: async (context) => {
        const path = join(context.scratch, 'cold-4000.db')
        await removeDatabase(path)
        const cache = new MetadataCache(path)
        try {
          return await elapsed(() =>
            scanDirectory(context.fixtures.lib4000, { recursive: true, cache })
          )
        } finally {
          cache.close()
          await removeDatabase(path)
        }
      }
    },
    {
      id: 'scan.4000.warm',
      title: 'scanDirectory, 4 000 photos, cache hit',
      unit: 'ms',
      budget: 250,
      setup: async (context) => {
        const path = join(context.scratch, 'warm-4000.db')
        await removeDatabase(path)
        const cache = new MetadataCache(path)
        try {
          await scanDirectory(context.fixtures.lib4000, { recursive: true, cache })
        } finally {
          cache.close()
        }
      },
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'warm-4000.db'))
        try {
          return await elapsed(() =>
            scanDirectory(context.fixtures.lib4000, { recursive: true, cache })
          )
        } finally {
          cache.close()
        }
      }
    },
    {
      id: 'scan.40000.cold',
      title: 'scanDirectory, 40 000 photos, empty cache',
      unit: 'ms',
      samples: 3,
      budget: 8000,
      tolerance: 0.5,
      requires: 'large',
      run: async (context) => {
        const path = join(context.scratch, 'cold-40000.db')
        await removeDatabase(path)
        const cache = new MetadataCache(path)
        try {
          return await elapsed(() => scanDirectory(context.large, { recursive: true, cache }))
        } finally {
          cache.close()
          await removeDatabase(path)
        }
      }
    },
    {
      id: 'scan.40000.warm',
      title: 'scanDirectory, 40 000 photos, cache hit',
      unit: 'ms',
      samples: 3,
      budget: 2000,
      requires: 'large',
      setup: async (context) => {
        const path = join(context.scratch, 'warm-40000.db')
        await removeDatabase(path)
        const cache = new MetadataCache(path)
        try {
          await scanDirectory(context.large, { recursive: true, cache })
        } finally {
          cache.close()
        }
      },
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'warm-40000.db'))
        try {
          return await elapsed(() => scanDirectory(context.large, { recursive: true, cache }))
        } finally {
          cache.close()
        }
      }
    },

    {
      id: 'open.reopen.4000',
      title: 'open the folder that is already open',
      unit: 'ms',
      samples: 7,
      budget: 20,
      // The short-circuit in `PhotoLibrary.open`: re-opening the current folder
      // answers from the list the watcher maintains. Without it this is a full
      // scan (~70 ms here, ~700 ms for 40 000 photos), which is why the budget
      // is set at a fifth of that — a removed short-circuit fails loudly.
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'reopen.db'))
        const library = new PhotoLibrary(join(context.scratch, 'reopen-thumbs'), () => {}, cache)
        try {
          await library.open(context.fixtures.lib4000, { recursive: true })
          await library.drain()
          return await elapsed(() => library.open(context.fixtures.lib4000, { recursive: true }))
        } finally {
          library.close()
          await library.drain()
          cache.close()
        }
      }
    },

    // ---- The metadata cache itself ----------------------------------------
    {
      id: 'cache.storeMany.40000',
      title: 'storeMany, 40 000 rows',
      unit: 'ms',
      samples: 3,
      budget: 400,
      setup: async (context) => {
        await removeDatabase(join(context.scratch, 'store.db'))
      },
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'store.db'))
        try {
          return await elapsed(() => cache.storeMany(rows))
        } finally {
          cache.close()
        }
      }
    },
    {
      id: 'cache.snapshot.40000',
      title: 'snapshot, 40 000 cached rows',
      unit: 'ms',
      samples: 5,
      budget: 250,
      setup: (context) => cacheWithRows(context, 'snapshot.db'),
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'snapshot.db'))
        try {
          return await elapsed(() => cache.snapshot(context.fixtures.lib40000))
        } finally {
          cache.close()
        }
      }
    },
    {
      id: 'cache.retain.40000',
      title: 'retain, 40 000 photos in one folder',
      unit: 'ms',
      samples: 3,
      budget: 300,
      setup: (context) => cacheWithRows(context, 'retain.db'),
      run: async (context) => {
        const cache = new MetadataCache(join(context.scratch, 'retain.db'))
        try {
          return await elapsed(() =>
            cache.retain(
              context.fixtures.lib40000,
              rows.map((row) => row.path)
            )
          )
        } finally {
          cache.close()
        }
      }
    },

    // ---- Layout and the renderer's per-change maths ------------------------
    {
      id: 'layout.sort.40000',
      title: 'sortPhotos, 40 000 photos',
      unit: 'ms',
      samples: 7,
      budget: 100,
      run: async () => elapsed(() => sortPhotos(photos, 'taken-desc'))
    },
    {
      id: 'layout.compute.40000.grid',
      title: 'computeLayout, 40 000 photos, grid',
      unit: 'ms',
      samples: 7,
      per: 20,
      budget: 20,
      tolerance: 0.3,
      run: repeated(20, () => computeLayout(photos, { mode: 'grid', containerWidth: 1600 }))
    },
    {
      id: 'layout.compute.40000.masonry',
      title: 'computeLayout, 40 000 photos, masonry',
      unit: 'ms',
      samples: 7,
      per: 20,
      budget: 20,
      tolerance: 0.3,
      run: repeated(20, () => computeLayout(photos, { mode: 'masonry', containerWidth: 1600 }))
    },
    {
      id: 'layout.minScale.40000',
      title: 'minScaleForTiles, 40 000 photos',
      unit: 'ms',
      samples: 9,
      budget: 120,
      // The real cost: the floor is a binary search, and every step re-lays out
      // the whole set. This is why feeding the wall in batches flickered.
      run: async () => {
        const viewport = { width: 1600, height: 1000 }
        const base = computeLayout(photos, { mode: 'grid', containerWidth: viewport.width })
        const floor = minScaleForWall(base.width, base.height, viewport.width, viewport.height)
        const visibleAt = (scale: number): number =>
          cullItems(
            computeLayout(photos, {
              mode: 'grid',
              containerWidth: Math.round(viewport.width / scale)
            }),
            { scale, x: 0, y: 0 },
            viewport.width,
            viewport.height,
            CULL_MARGIN,
            Number.MAX_SAFE_INTEGER
          ).items.length
        return elapsed(() => minScaleForTiles(visibleAt, MAX_MOUNTED_TILES, floor))
      }
    },
    {
      id: 'layout.cull.40000',
      title: 'cullItems, 40 000 photos on screen',
      unit: 'ms',
      samples: 7,
      per: 20,
      budget: 8,
      tolerance: 0.3,
      run: (() => {
        const layout = computeLayout(photos, { mode: 'grid', containerWidth: 1600 })
        return repeated(20, () => cullItems(layout, { scale: 1, x: 0, y: 0 }, 1600, 1000))
      })()
    },
    {
      id: 'filters.apply.40000',
      title: 'applyFilters, 40 000 photos, date + text',
      unit: 'ms',
      samples: 7,
      per: 10,
      budget: 20,
      run: repeated(10, () =>
        applyFilters(photos, { from: '2010-01-01', to: '2020-12-31', text: 'IMG_01' })
      )
    },

    // ---- Thumbnails --------------------------------------------------------
    thumbCase('wall'),
    thumbCase('zoom'),

    // ---- What the scan's result costs to hand over -------------------------
    {
      id: 'ipc.encode.40000',
      title: 'JSON.stringify, 40 000 photos',
      unit: 'ms',
      samples: 5,
      budget: 90,
      run: async () => elapsed(() => JSON.stringify(photos))
    },
    {
      id: 'ipc.decode.40000',
      title: 'JSON.parse, 40 000 photos',
      unit: 'ms',
      samples: 5,
      budget: 90,
      run: async () => {
        const payload = JSON.stringify(photos)
        return elapsed(() => JSON.parse(payload))
      }
    }
  ]
}

/** Prepare the scratch directory the cases write into. */
export async function prepareScratch(scratch: string): Promise<void> {
  await mkdir(scratch, { recursive: true })
}
