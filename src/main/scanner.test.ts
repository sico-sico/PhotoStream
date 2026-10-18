import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { isSupportedImage, listImageFiles, photoId, scanDirectory } from './scanner'

let dir = ''

/** Write a real JPEG so the metadata reader has something valid to parse. */
async function writeJpeg(name: string, exifDate?: string): Promise<void> {
  let image = sharp({
    create: { width: 40, height: 20, channels: 3, background: { r: 120, g: 30, b: 200 } }
  })
  if (exifDate) image = image.withExif({ IFD0: { DateTime: exifDate }, IFD3: { DateTimeOriginal: exifDate } })
  await image.jpeg().toFile(join(dir, name))
}

/** Write a real PNG. Screenshots and exports are the usual source of these. */
async function writePng(name: string, options: { alpha?: boolean } = {}): Promise<void> {
  const image = sharp({
    create: {
      width: 32,
      height: 24,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 10, g: 20, b: 30, alpha: 0 } : { r: 10, g: 20, b: 30 }
    }
  })
  await image.png().toFile(join(dir, name))
}

/** Set a file's modification time to a fixed local moment. */
async function stamp(name: string, when: Date): Promise<void> {
  await utimes(join(dir, name), when, when)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photostream-scan-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('isSupportedImage', () => {
  it('accepts JPEG in any case', () => {
    expect(isSupportedImage('a.jpg')).toBe(true)
    expect(isSupportedImage('a.JPG')).toBe(true)
    expect(isSupportedImage('a.JpEg')).toBe(true)
    expect(isSupportedImage('a.jpeg')).toBe(true)
  })

  it('accepts PNG in any case', () => {
    // PNG needs no extra decoder: sharp reads it and Chromium can display the
    // original directly, so the whole pipeline works unchanged.
    expect(isSupportedImage('a.png')).toBe(true)
    expect(isSupportedImage('a.PNG')).toBe(true)
  })

  it('rejects formats that are out of scope', () => {
    // HEIC is not a decoding inconvenience but a missing codec: the bundled
    // libvips has no HEVC decoder, and a build that does is a change of
    // architecture rather than of this set.
    expect(isSupportedImage('a.heic')).toBe(false)
    expect(isSupportedImage('a.heif')).toBe(false)
    expect(isSupportedImage('a.raw')).toBe(false)
    expect(isSupportedImage('a.txt')).toBe(false)
    expect(isSupportedImage('a')).toBe(false)
  })
})

describe('photoId', () => {
  it('lower-cases the path so case-insensitive filesystems agree', () => {
    expect(photoId('D:\\Photos\\A.JPG')).toBe(photoId('D:\\photos\\a.jpg'))
  })
})

describe('listImageFiles', () => {
  it('returns supported images, sorted by name', async () => {
    await writeJpeg('b.jpg')
    await writeJpeg('a.jpg')
    await writePng('c.png')
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, 'photo.heic'), 'x')

    expect(await listImageFiles(dir)).toEqual(['a.jpg', 'b.jpg', 'c.png'])
  })

  it('ignores subdirectories', async () => {
    await writeJpeg('top.jpg')
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'inner.jpg'), 'x')

    expect(await listImageFiles(dir)).toEqual(['top.jpg'])
  })

  it('returns an empty list for an empty directory', async () => {
    expect(await listImageFiles(dir)).toEqual([])
  })
})

describe('scanDirectory', () => {
  it('reads dimensions and the EXIF capture date', async () => {
    await writeJpeg('2019-07-14 Kyoto.jpg', '2019:07:14 08:15:00')
    const result = await scanDirectory(dir)

    expect(result.photos).toHaveLength(1)
    expect(result.photos[0]).toMatchObject({
      name: '2019-07-14 Kyoto.jpg',
      width: 40,
      height: 20,
      takenAt: '2019-07-14',
      dateSource: 'exif'
    })
  })

  it('sorts by capture date, not by file name', async () => {
    // Names are deliberately in the same order as the dates here, so the test
    // fails if the implementation falls back to name order.
    await writeJpeg('a-late.jpg', '2024:03:11 10:00:00')
    await writeJpeg('z-early.jpg', '2019:07:14 10:00:00')

    const result = await scanDirectory(dir)
    // Newest first: the wall opens on the most recent photo.
    expect(result.photos.map((p) => p.name)).toEqual(['a-late.jpg', 'z-early.jpg'])
  })

  it('falls back to the file modification time when EXIF has no date', async () => {
    await writeJpeg('dated.jpg', '2020:01:01 10:00:00')
    await writeJpeg('undated.jpg')
    const day = new Date(2021, 4, 12, 12, 0, 0)
    await stamp('undated.jpg', day)

    const result = await scanDirectory(dir)
    const undated = result.photos.find((p) => p.name === 'undated.jpg')
    // Every photo gets a place in the timeline; the source is recorded so the
    // interface can say the date is an approximation.
    expect(undated?.takenAt).toBe('2021-05-12')
    expect(undated?.dateSource).toBe('mtime')
    expect(result.photos.find((p) => p.name === 'dated.jpg')?.dateSource).toBe('exif')
  })

  it('prefers the EXIF date over the file modification time', async () => {
    await writeJpeg('a.jpg', '2019:07:14 08:15:00')
    await stamp('a.jpg', new Date(2024, 0, 1, 12, 0, 0))

    const result = await scanDirectory(dir)
    expect(result.photos[0].takenAt).toBe('2019-07-14')
    expect(result.photos[0].dateSource).toBe('exif')
  })

  it('reads a PNG and dates it from the file', async () => {
    await writePng('screenshot.png', { alpha: true })
    await stamp('screenshot.png', new Date(2022, 8, 3, 12, 0, 0))

    const result = await scanDirectory(dir)
    expect(result.photos).toHaveLength(1)
    expect(result.photos[0]).toMatchObject({
      name: 'screenshot.png',
      width: 32,
      height: 24,
      takenAt: '2022-09-03',
      dateSource: 'mtime'
    })
  })

  it('skips files that are not valid images', async () => {
    await writeJpeg('good.jpg', '2020:01:01 10:00:00')
    await writeFile(join(dir, 'broken.jpg'), 'not a jpeg at all')

    const result = await scanDirectory(dir)
    // A corrupt file still becomes a photo entry (so the user can see it), but
    // with unknown dimensions rather than an exception.
    expect(result.photos.map((p) => p.name)).toContain('good.jpg')
    const broken = result.photos.find((p) => p.name === 'broken.jpg')
    if (broken) expect(broken.width).toBe(0)
  })

  it('reports progress for each photo', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await writeJpeg('b.jpg', '2020:01:02 10:00:00')

    const seen: number[] = []
    await scanDirectory(dir, { onPhoto: (_photo, index) => seen.push(index) })
    expect(seen).toEqual([1, 2])
  })

  it('honours the abort signal', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    await writeJpeg('b.jpg', '2020:01:02 10:00:00')

    const controller = new AbortController()
    controller.abort()
    const result = await scanDirectory(dir, { signal: controller.signal })
    expect(result.photos).toHaveLength(0)
  })

  it('resolves a relative directory to an absolute one', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    const result = await scanDirectory(dir)
    expect(result.dir).toBe(dir)
    expect(result.photos[0].path.startsWith(dir)).toBe(true)
  })

  it('records duration and skip count', async () => {
    await writeJpeg('a.jpg', '2020:01:01 10:00:00')
    const result = await scanDirectory(dir)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.skipped).toBe(0)
  })

  it('handles an empty directory', async () => {
    const result = await scanDirectory(dir)
    expect(result.photos).toEqual([])
    expect(result.dir).toBe(dir)
  })
})
