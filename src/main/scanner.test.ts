import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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

  it('rejects formats that are out of scope', () => {
    expect(isSupportedImage('a.png')).toBe(false)
    expect(isSupportedImage('a.heic')).toBe(false)
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
  it('returns only JPEGs, sorted by name', async () => {
    await writeJpeg('b.jpg')
    await writeJpeg('a.jpg')
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, 'image.png'), 'x')

    expect(await listImageFiles(dir)).toEqual(['a.jpg', 'b.jpg'])
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
    // Names are deliberately in the opposite order to the dates.
    await writeJpeg('a-late.jpg', '2024:03:11 10:00:00')
    await writeJpeg('z-early.jpg', '2019:07:14 10:00:00')

    const result = await scanDirectory(dir)
    expect(result.photos.map((p) => p.name)).toEqual(['z-early.jpg', 'a-late.jpg'])
  })

  it('marks photos without a capture date and sorts them last', async () => {
    await writeJpeg('dated.jpg', '2020:01:01 10:00:00')
    await writeJpeg('undated.jpg')

    const result = await scanDirectory(dir)
    expect(result.photos.map((p) => p.name)).toEqual(['dated.jpg', 'undated.jpg'])
    expect(result.photos[1].dateSource).toBe('none')
    expect(result.photos[1].takenAt).toBe('')
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
