import sharp from 'sharp'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ThumbLevel, ThumbPriority } from '../shared/types'
import { THUMB_SIZES, thumbKey, zoomTierAddsDetail } from '../shared/thumbs'

/**
 * Thumbnail generation.
 *
 * `sharp` (libvips) is used rather than Electron's
 * `nativeImage.createThumbnailFromPath`: measured on this machine the former is
 * ~5.5x faster and produces files ~10x smaller for camera JPEGs.
 *
 * Concurrency is 4. libvips already runs its own thread pool, so raising this
 * further gave no measurable gain (~7.4 s vs 7.7 s for 200 photos) while
 * increasing peak memory.
 */

/**
 * libvips caches decoded images and keeps the source file mapped, which on
 * Windows leaves the photo locked until the process exits. That breaks a core
 * workflow: re-exporting a photo from Lightroom over the same file name fails
 * with "unable to open for write" while the wall is open. Verified on Windows:
 * every `sharp()` option combination held the lock, and disabling the cache was
 * the only thing that released it.
 *
 * The cost is re-reading a JPEG instead of reusing a cached decode, which is
 * negligible here because each source is read once per rendition key, and the
 * on-disk thumbnail cache already prevents repeat work.
 */
sharp.cache(false)

export const THUMB_CONCURRENCY = 4

export const THUMB_QUALITY = { wall: 78, zoom: 82 } as const

/**
 * Quality for a display-sized rendition.
 *
 * Higher than `zoom` because it is the tier a single photo is read at, and
 * because a sized rendition is already the final one: unlike `zoom` it will not
 * be downscaled again by the browser, so any artefact it carries stays visible.
 * Measured at 1840 px on a real photo, quality 82 and quality 95 differ by 0.6%
 * in gradient energy, so this is a modest bump rather than a lever.
 */
export const VIEWER_QUALITY = 85

export interface ThumbRequest {
  sourcePath: string
  mtimeMs: number
  sizeBytes: number
  /** Only the cached levels are ever generated; `full` streams the original. */
  level: Exclude<ThumbLevel, 'full'>
  /**
   * Long edge to generate, overriding the level's fixed size.
   *
   * Set by the viewer, which knows the exact device-pixel size it will paint at.
   * Cached under its own tag, so a sized rendition never collides with the
   * `zoom` file the wall uses.
   */
  maxEdge?: number
  /**
   * Pixel dimensions of the source, as parsed during the scan.
   *
   * Used to skip a `zoom` rendition that cannot hold more detail than `wall`.
   * Absent is treated as "unknown", which keeps the rendition.
   */
  sourceWidth?: number
  sourceHeight?: number
}

/**
 * The level a request actually produces.
 *
 * A `zoom` rendition of a photo whose long edge is already within the `wall`
 * size would hold exactly the same pixels — `buildThumbnail` never enlarges —
 * so it is served from the `wall` file instead. That saves one encode and one
 * file per small photo, which is the whole cost of the second tier for them.
 */
export function effectiveLevel(request: ThumbRequest): Exclude<ThumbLevel, 'full'> {
  if (request.level !== 'zoom') return request.level
  const width = request.sourceWidth ?? 0
  const height = request.sourceHeight ?? 0
  return zoomTierAddsDetail(width, height) ? 'zoom' : 'wall'
}

/**
 * Cache tag for a request: what distinguishes one rendition from another.
 *
 * `wall` is shared with the photo wall even when the viewer asks for a sized
 * rendition, because a source smaller than the wall size produces the same file
 * either way; generating a second one would be pure duplication.
 */
export function renditionTag(request: ThumbRequest): string {
  if (effectiveLevel(request) === 'wall') return 'wall'
  return request.maxEdge ? `viewer${request.maxEdge}` : 'zoom'
}

/** Long edge this request will be encoded at. */
export function renditionSize(request: ThumbRequest): number {
  if (effectiveLevel(request) === 'wall') return THUMB_SIZES.wall
  return request.maxEdge ?? THUMB_SIZES.zoom
}

/** WebP quality this request will be encoded at. */
export function renditionQuality(request: ThumbRequest): number {
  if (effectiveLevel(request) === 'wall') return THUMB_QUALITY.wall
  return request.maxEdge ? VIEWER_QUALITY : THUMB_QUALITY.zoom
}

/**
 * Absolute path of a rendition.
 *
 * `thumbKey` returns a sharded relative path (`a/b/hash-wall.webp`); `join`
 * normalises the forward slashes to the platform separator. The directory is
 * created by `buildThumbnail`, not here, so this stays a pure function that
 * tests can call repeatedly.
 */
export function thumbPath(cacheDir: string, request: ThumbRequest): string {
  return join(
    cacheDir,
    thumbKey(request.sourcePath, request.mtimeMs, request.sizeBytes, renditionTag(request))
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * In-flight encodes, keyed by target path.
 *
 * The same rendition is routinely requested twice at once: opening a folder
 * pre-warms every thumbnail in the background while the renderer asks for the
 * ones on screen. Without this, both callers see "no file yet", both encode, and
 * the second `rename` fails on Windows because the destination already exists.
 * Sharing the promise means one encode and one result.
 */
const inFlight = new Map<string, Promise<string>>()

/**
 * Global cap on concurrent encodes.
 *
 * The renderer asks for a screenful at a time, which can be hundreds of photos.
 * Starting them all at once floods the disk queue and libvips, and the first
 * visible thumbnail ends up stuck behind all of them — measured at ~15 s for the
 * first tile of a 3226-photo library. Four matches the throughput sweet spot
 * from the benchmark while keeping latency low for the tiles the user is
 * actually looking at.
 */
const MAX_CONCURRENT_ENCODES = 4
let activeEncodes = 0

/**
 * Waiting encodes, in two priority lanes.
 *
 * A single FIFO was the reason scrollbar prefetching made things *worse*: a
 * prefetch of hundreds of destination tiles sat at the head of the queue, so the
 * tiles already on screen — the ones the user is looking at — waited behind
 * them. Measured on 3226 photos: 15 s after a jump, 14 of 81 visible tiles were
 * still empty.
 *
 * `interactive` is for what is on screen right now; `background` is for
 * speculative work like scroll prefetching. Interactive always drains first.
 */
const lanes: { interactive: Array<() => void>; background: Array<() => void> } = {
  interactive: [],
  background: []
}

/** Which lane a request belongs to. Re-exported so callers need one import. */
export type { ThumbPriority }

async function acquire(priority: ThumbPriority): Promise<void> {
  if (activeEncodes < MAX_CONCURRENT_ENCODES) {
    activeEncodes += 1
    return
  }
  await new Promise<void>((resolve) => lanes[priority].push(resolve))
  activeEncodes += 1
}

function release(): void {
  activeEncodes -= 1
  // Interactive first: a prefetch must never delay a tile the user can see.
  const next = lanes.interactive.shift() ?? lanes.background.shift()
  if (next) next()
}

/**
 * Ensure a thumbnail exists on disk and return its path.
 * Writes to a temporary name first so a crash mid-encode cannot leave a
 * half-written file that later looks like a cache hit.
 */
export async function ensureThumbnail(
  cacheDir: string,
  request: ThumbRequest,
  priority: ThumbPriority = 'interactive'
): Promise<string> {
  const target = thumbPath(cacheDir, request)
  if (await exists(target)) return target

  const pending = inFlight.get(target)
  if (pending) return pending

  const job = encodeWithLimit(target, request, priority).finally(() => {
    inFlight.delete(target)
  })
  inFlight.set(target, job)
  return job
}

async function encodeWithLimit(target: string, request: ThumbRequest, priority: ThumbPriority): Promise<string> {
  await acquire(priority)
  try {
    return await buildThumbnail(target, request)
  } finally {
    release()
  }
}

async function buildThumbnail(target: string, request: ThumbRequest): Promise<string> {
  // Re-check: a concurrent caller may have finished while this one waited.
  if (await exists(target)) return target

  await mkdir(dirname(target), { recursive: true })
  const size = renditionSize(request)
  const quality = renditionQuality(request)
  // Unique per attempt: two *processes* can still race (unlikely here), and a
  // shared temp name would corrupt both outputs.
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`

  try {
    await sharp(request.sourcePath, { sequentialRead: true, failOn: 'none' })
      // Honour EXIF orientation even though these exports are already baked.
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toFile(temp)
    await rename(temp, target)
    return target
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Build thumbnails for many photos, with a small worker pool.
 * `onDone` fires per completed item so the UI can advance a progress bar.
 */
export async function ensureThumbnails(
  cacheDir: string,
  requests: readonly ThumbRequest[],
  options: {
    concurrency?: number
    onDone?: (done: number, total: number) => void
    signal?: AbortSignal
    /** `background` for speculative work such as scroll prefetching. */
    priority?: ThumbPriority
  } = {}
): Promise<{ built: number; failed: number }> {
  const concurrency = Math.max(1, options.concurrency ?? THUMB_CONCURRENCY)
  const priority = options.priority ?? 'interactive'
  let cursor = 0
  let done = 0
  let built = 0
  let failed = 0
  const total = requests.length

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total || options.signal?.aborted) return
      try {
        await ensureThumbnail(cacheDir, requests[index], priority)
        built += 1
      } catch {
        failed += 1
      }
      done += 1
      options.onDone?.(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  return { built, failed }
}
