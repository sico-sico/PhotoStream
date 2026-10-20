import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { IPC } from '../shared/ipc'

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

let photoDir = ''
let cacheDir = ''
let notices: Array<{ channel: string; payload: unknown }> = []
let library: InstanceType<typeof PhotoLibrary>

async function writeJpeg(name: string, exifDate?: string): Promise<void> {
  let image = sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 20, g: 140, b: 90 } }
  })
  if (exifDate) image = image.withExif({ IFD0: { DateTime: exifDate }, IFD3: { DateTimeOriginal: exifDate } })
  await image.jpeg().toFile(join(photoDir, name))
}

beforeEach(async () => {
  photoDir = await mkdtemp(join(tmpdir(), 'photostream-lib-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-libcache-'))
  notices = []
  library = new PhotoLibrary(cacheDir, (channel, payload) => notices.push({ channel, payload }))
})

afterEach(async () => {
  library.close()
  // `warmThumbnails` queues work on the library; let it drain before removing
  // the source directory, otherwise a running encode keeps a file locked.
  await library.drain()
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
    expect(url).toContain('-wall.webp')
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
    expect(url).toContain('-wall880.webp')
  })

  it('reuses the same URL for repeated requests', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await library.open(photoDir)

    const first = await library.thumbUrlFor(library.all[0], 'wall')
    const second = await library.thumbUrlFor(library.all[0], 'wall')
    expect(second).toBe(first)
  })

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
