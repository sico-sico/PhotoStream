import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { IPC } from '../shared/ipc'
import type { Photo } from '../shared/types'

/**
 * `ipc.ts` imports `electron` for `dialog`/`shell`/`ipcMain`. Only
 * `PhotoLibrary` is under test here, and it touches none of those, so a small
 * stub is enough to load the module outside Electron.
 */
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

const { PhotoLibrary } = await import('./ipc')
const { MetadataCache } = await import('./metadata-cache')

let photoDir = ''
let cacheDir = ''
let notices: Array<{ channel: string; payload: unknown }> = []
let library: InstanceType<typeof PhotoLibrary>
let metadataCache: InstanceType<typeof MetadataCache>

async function writeJpeg(name: string, exifDate?: string): Promise<void> {
  let image = sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 20, g: 140, b: 90 } }
  })
  if (exifDate) image = image.withExif({ IFD0: { DateTime: exifDate }, IFD3: { DateTimeOriginal: exifDate } })
  await image.jpeg().toFile(join(photoDir, name))
}

/**
 * Open something else, so the next `open(photoDir)` is not a re-open.
 *
 * Re-opening the folder that is already open now short-circuits (no scan, no
 * seed), which is right for the user but leaves tests that want the *scanning*
 * path with nothing to exercise.
 */
async function stepAway(): Promise<void> {
  const other = await mkdtemp(join(tmpdir(), 'photostream-step-'))
  try {
    await library.open(other)
    await library.drain()
  } finally {
    await rm(other, { recursive: true, force: true })
  }
}

beforeEach(async () => {
  photoDir = await mkdtemp(join(tmpdir(), 'photostream-lib-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-libcache-'))
  notices = []
  // A real database: `cachedPhotos` reads through it, and the scan writes to it,
  // so the two have to agree on paths and separators.
  metadataCache = new MetadataCache(join(cacheDir, 'metadata.db'))
  library = new PhotoLibrary(cacheDir, (channel, payload) => notices.push({ channel, payload }), metadataCache)
})

afterEach(async () => {
  library.close()
  // `warmThumbnails` queues work on the library; let it drain before removing
  // the source directory, otherwise a running encode keeps a file locked.
  await library.drain()
  metadataCache.close()
  await rm(photoDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

describe('PhotoLibrary', () => {
  it('opens a directory and exposes its photos', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await writeJpeg('b.jpg', '2021:06:15 10:00:00')

    const result = await library.open(photoDir)

    expect(result.dir).toBe(photoDir)
    expect(result.photos).toHaveLength(2)
    expect(library.directory).toBe(photoDir)
    expect(library.all).toHaveLength(2)
  })

  it('orders photos by capture date on open, newest first', async () => {
    await writeJpeg('later.jpg', '2022:01:01 10:00:00')
    await writeJpeg('earlier.jpg', '2019:01:01 10:00:00')

    await library.open(photoDir)
    expect(library.all.map((photo) => photo.name)).toEqual(['later.jpg', 'earlier.jpg'])
  })

  it('reports skip and duration metadata', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    const result = await library.open(photoDir)
    expect(result.skipped).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('replaces the previous library when opening a second directory', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    const other = await mkdtemp(join(tmpdir(), 'photostream-lib2-'))
    try {
      await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .jpeg()
        .toFile(join(other, 'only.jpg'))

      await library.open(other)
      expect(library.directory).toBe(other)
      expect(library.all).toHaveLength(1)
      expect(library.all[0].name).toBe('only.jpg')
    } finally {
      // The newly opened library queues thumbnails for `other`; wait for that
      // work before deleting the directory, or Windows reports EBUSY.
      library.close()
      await library.drain()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('resolves a thumbnail URL on demand', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    const url = await library.thumbUrlFor(library.all[0], 'wall')
    expect(url.startsWith('pic://thumb/')).toBe(true)
    expect(url).toContain('-wall512q78p1.webp')
  })

  it('sizes a panorama from the dimensions the scan parsed', async () => {
    // The wall rendition is aspect-aware, and the dimensions come from the
    // scan: nothing here reads the file again. A 4:1 photo is painted 880px
    // wide by the justified layout, so that is the rendition it gets.
    await sharp({ create: { width: 600, height: 150, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .jpeg()
      .toFile(join(photoDir, 'pano.jpg'))
    await library.open(photoDir)

    const pano = library.all.find((photo) => photo.name === 'pano.jpg')!
    const url = await library.thumbUrlFor(pano, 'wall')
    expect(url).toContain('-wall880q78p1.webp')
  })

  it('reuses the same URL for repeated requests', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    const first = await library.thumbUrlFor(library.all[0], 'wall')
    const second = await library.thumbUrlFor(library.all[0], 'wall')
    expect(second).toBe(first)
  })

  describe('prefetching the folder the renderer is about to open', () => {
    it('adopts the scan instead of reading the folder twice', async () => {
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await writeJpeg('b.jpg', '2021:06:15 10:00:00')

      library.prefetch(photoDir)
      // Give the speculative scan a chance to finish before the renderer asks;
      // adoption must work whether it finished or is still running.
      await new Promise((resolve) => setTimeout(resolve, 100))

      const result = await library.open(photoDir)
      expect(result.photos).toHaveLength(2)
      expect(library.directory).toBe(photoDir)
      expect(library.scanSignals).toHaveLength(1)
    })

    it('adopts a prefetch that is still running', async () => {
      for (let index = 0; index < 6; index++) await writeJpeg(`p${index}.jpg`, '2020:01:01 10:00:00')

      library.prefetch(photoDir)
      const result = await library.open(photoDir)

      expect(result.photos).toHaveLength(6)
      expect(library.scanSignals).toHaveLength(1)
    })

    it('abandons the prefetch when another folder is opened', async () => {
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      const other = await mkdtemp(join(tmpdir(), 'photostream-prefetch-'))
      try {
        await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .jpeg()
          .toFile(join(other, 'only.jpg'))

        library.prefetch(photoDir)
        await library.open(other)

        expect(library.scanSignals[0].aborted).toBe(true)
        expect(library.directory).toBe(other)
        expect(library.all.map((photo) => photo.name)).toEqual(['only.jpg'])
      } finally {
        library.close()
        await library.drain()
        await rm(other, { recursive: true, force: true })
      }
    })

    it('does not adopt a prefetch made with the other recursion setting', async () => {
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')

      library.prefetch(photoDir, { recursive: false })
      await library.open(photoDir, { recursive: true })

      // Two scans: the mismatch is abandoned rather than reused for a mode it
      // was not made for.
      expect(library.scanSignals).toHaveLength(2)
      expect(library.all).toHaveLength(1)
    })
  })

  describe('cached photos', () => {
    it('describes a folder from the metadata cache without reading it', async () => {
      // The wall can be painted from this before the scan finishes; it is a
      // placeholder, so the shape has to match what a scan produces exactly.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)

      const cached = library.cachedPhotos(photoDir, false)
      expect(cached.map((photo) => photo.name)).toEqual(['a.jpg'])
      expect(cached[0].takenAt).toBe('2020-01-01')
      expect(cached[0].width).toBe(60)
      expect(cached[0].path).toBe(join(photoDir, 'a.jpg'))
      expect(cached[0].id).toBe(join(photoDir, 'a.jpg').toLowerCase())
    })

    it('honours the recursion setting', async () => {
      await writeJpeg('top.jpg', '2020:01:01 10:00:00')
      await mkdir(join(photoDir, 'inner'), { recursive: true })
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .toFile(join(photoDir, 'inner', 'nested.jpg'))
      await library.open(photoDir, { recursive: true })

      expect(library.cachedPhotos(photoDir, true).map((photo) => photo.name).sort()).toEqual([
        'inner/nested.jpg',
        'top.jpg'
      ])
      // A non-recursive view of the same folder hides the subfolder's photo,
      // exactly as the scanner would.
      expect(library.cachedPhotos(photoDir, false).map((photo) => photo.name)).toEqual(['top.jpg'])
    })

    it('returns nothing for a folder that was never scanned', async () => {
      const other = await mkdtemp(join(tmpdir(), 'photostream-never-'))
      try {
        expect(library.cachedPhotos(other, false)).toEqual([])
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    })

    it('opens with the cached photos reported as one snapshot', async () => {
      // The snapshot is what lets the wall paint before the disk has been
      // walked. It is a single message: the renderer re-lays out its whole
      // photo set on every change, so piecewise delivery would flicker.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      // Step away first: re-opening the folder that is already open no longer
      // scans at all (see the short-circuit test), so there would be nothing to
      // seed.
      await stepAway()
      notices.length = 0

      await library.open(photoDir)
      const seeds = notices.filter((notice) => notice.channel === IPC.scanSeed)
      expect(seeds).toHaveLength(1)
      expect((seeds[0].payload as { dir: string }).dir).toBe(photoDir)
      expect((seeds[0].payload as { photos: Photo[] }).photos.map((photo) => photo.name)).toEqual(['a.jpg'])
    })

    it('does not report a seed for a folder with nothing cached', async () => {
      const fresh = await mkdtemp(join(tmpdir(), 'photostream-uncached-'))
      try {
        await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .jpeg()
          .toFile(join(fresh, 'new.jpg'))
        await library.open(fresh)
        expect(notices.filter((notice) => notice.channel === IPC.scanSeed)).toEqual([])
      } finally {
        await rm(fresh, { recursive: true, force: true })
      }
    })

    it('still seeds the wall when it adopts a prefetch that is still running', async () => {
      // The startup path: the prefetch began before the renderer was listening,
      // so its result is still a couple of hundred milliseconds away and the
      // cache can paint the wall in the meantime.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      notices.length = 0

      library.prefetch(photoDir)
      const result = await library.open(photoDir)
      expect(result.photos).toHaveLength(1)
      const seed = notices.find((notice) => notice.channel === IPC.scanSeed)
      expect(seed).toBeDefined()
      expect((seed!.payload as { dir: string }).dir).toBe(photoDir)
    })

    it('announces the snapshot under the string the drop used', async () => {
      // A dropped photo asks with a file path but opens its folder; the
      // renderer keys the seed on what it sent, so the two have to agree or the
      // wall stays blank until the scan finishes.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      await stepAway()
      notices.length = 0

      const photo = join(photoDir, 'a.jpg')
      await library.open(photoDir, { announceAs: photo })
      const seed = notices.find((notice) => notice.channel === IPC.scanSeed)
      expect(seed).toBeDefined()
      expect((seed!.payload as { dir: string }).dir).toBe(photo)
    })

    it('answers a re-open of the same folder without scanning it again', async () => {
      // The history menu and a repeated picker choice both land here. A full
      // scan of 40 000 photos costs ~700 ms of `stat` calls even with every
      // metadata row cached, for an answer the watcher already maintains.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      const first = await library.open(photoDir)
      await library.drain()
      notices.length = 0

      const again = await library.open(photoDir)
      // The very same array: nothing was read, so nothing can have changed.
      expect(again.photos).toBe(first.photos)
      expect(again.durationMs).toBe(0)
      // ...and the background re-check found no difference, so the wall is not
      // asked to re-render.
      await library.drain()
      expect(notices.filter((notice) => notice.channel === IPC.scanSeed)).toEqual([])
      expect(notices.filter((notice) => notice.channel === IPC.photosChanged)).toEqual([])
    })

    it('reports a replacement when a re-open finds the folder changed', async () => {
      // The watcher normally sees this first, so what is pinned here is the
      // end state either way: a file that appeared while the folder was open is
      // on the wall after re-opening it.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      await library.drain()

      await writeJpeg('b.jpg', '2021:02:02 10:00:00')
      await library.open(photoDir)
      await waitFor(() => library.all.length === 2)

      expect(library.all.map((photo) => photo.name).sort()).toEqual(['a.jpg', 'b.jpg'])
    })

    it('scans again when the recursion setting changed', async () => {
      // Same folder, different mode: the short-circuit must not answer with a
      // list built under the other mode.
      await mkdir(join(photoDir, 'sub'))
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      const flat = await library.open(photoDir)
      expect(flat.photos).toHaveLength(1)

      const nested = await library.open(photoDir, { recursive: true })
      expect(nested.photos).toBe(library.all)
      expect(library.all).toHaveLength(1)
    })

    it('does not re-send the cache once the prefetch has finished', async () => {
      // Its answer is already in flight; a seed would only be a stale copy.
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      library.prefetch(photoDir)
      // The scan writes the cache row as it parses; once it is there, the
      // speculative scan has finished.
      await waitFor(() => metadataCache.list(photoDir).length === 1)
      notices.length = 0

      await library.open(photoDir)
      expect(notices.filter((notice) => notice.channel === IPC.scanSeed)).toEqual([])
    })
  })

  /** Poll until `predicate` holds; asynchronous work settles in later ticks. */
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  describe('watching', () => {
    /** Poll until `predicate` holds; watcher events are asynchronous. */
    async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }

    function deltaCount(): number {
      return notices.filter((notice) => notice.channel === IPC.photosChanged).length
    }

    it('adds a photo that appears while the library is open', async () => {
      await writeJpeg('first.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)

      await writeJpeg('second.jpg', '2021:01:01 10:00:00')
      await waitFor(() => library.all.length === 2)

      expect(library.all.map((photo) => photo.name)).toEqual(['second.jpg', 'first.jpg'])
      expect(deltaCount()).toBeGreaterThan(0)
    })

    it('notifies the renderer when a photo is deleted', async () => {
      // A deletion changes the wall but produces no photo to thumbnail, so it
      // is the case most likely to be dropped by an "any changes?" guard.
      await writeJpeg('doomed.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      await waitFor(() => library.all.length === 1)

      const before = deltaCount()
      await unlink(join(photoDir, 'doomed.jpg'))

      await waitFor(() => library.all.length === 0)
      await waitFor(() => deltaCount() > before)

      const last = notices.filter((notice) => notice.channel === IPC.photosChanged).at(-1)
      expect(last?.payload).toMatchObject({ kind: 'delta' })
    })

    it('picks up a rewritten photo', async () => {
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)

      await writeJpeg('a.jpg', '2023:05:05 10:00:00')
      await waitFor(() => library.all[0]?.takenAt === '2023-05-05')
      expect(library.all).toHaveLength(1)
    })

    it('stops watching after close', async () => {
      await writeJpeg('a.jpg', '2020:01:01 10:00:00')
      await library.open(photoDir)
      library.close()

      await writeJpeg('b.jpg', '2021:01:01 10:00:00')
      await new Promise((resolve) => setTimeout(resolve, 800))
      expect(library.all).toHaveLength(1)
    })
  })

  it('does not warm thumbnails on open', async () => {
    // Generating renditions for the whole folder made large libraries take
    // minutes before the wall felt usable. Opening must only scan and watch.
    const photos = Array.from({ length: 6 }, (_, i) => `photo${i}.jpg`)
    for (const name of photos) await writeJpeg(name, '2020:01:01 10:00:00')

    await library.open(photoDir)
    await library.drain()

    expect(notices.some((notice) => notice.channel === IPC.thumbProgress)).toBe(false)
  })

  it('reports progress when thumbnails are warmed explicitly', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    library.warmThumbnails(library.all, 'wall')
    await library.drain()

    const progress = notices.filter((notice) => notice.channel === IPC.thumbProgress)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)?.payload).toEqual({ done: 1, total: 1 })
  })

  it('never generates anything for the full level', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    library.warmThumbnails(library.all, 'full')
    await library.drain()

    expect(notices.some((notice) => notice.channel === IPC.thumbProgress)).toBe(false)
  })

  it('serves the original file for the full level', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    // No encode, no cache entry: the original is streamed instead, which is
    // what keeps the wall sharp at high zoom.
    const url = await library.thumbUrlFor(library.all[0], 'full')
    expect(url.startsWith('pic://photo/')).toBe(true)
    expect(url).toContain('a.jpg')
  })

  it('does nothing when closed before ever opening', () => {
    expect(() => library.close()).not.toThrow()
  })

  it('has an empty directory before any open call', () => {
    expect(library.directory).toBe('')
    expect(library.all).toEqual([])
  })

  it('survives a directory that does not exist', async () => {
    await expect(library.open(join(photoDir, 'missing'))).rejects.toThrow()
  })

  it('ignores non-JPEG files added while watching', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    await writeFile(join(photoDir, 'notes.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(library.all).toHaveLength(1)
  })
})
