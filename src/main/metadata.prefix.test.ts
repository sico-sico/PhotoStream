import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * Two-stage metadata reads.
 *
 * The scan used to read 512 KB per photo to find EXIF. Most of that was waste:
 * the segment sits in the first few kilobytes. The optimisation is only safe if
 * the fallback still finds dates that sit past the small window, so both paths
 * are covered here — including the *number of reads*, because a fallback that
 * never fires would pass a date-only test on files whose EXIF is near the start.
 */

const reads: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      reads.push(String(args[0]))
      return actual.open(...args)
    }
  }
})

const { METADATA_FIRST_READ_BYTES, readImageMetadata } = await import('./metadata')

let dir = ''

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
  reads.length = 0
})

async function writeJpeg(name: string, exifDate?: string, paddingBytes = 0): Promise<string> {
  const base = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 90 } }
  })
    .withExif(exifDate ? { IFD2: { DateTimeOriginal: exifDate } } : {})
    .jpeg()
    .toBuffer()

  // Comment segments are skipped by every decoder, so they are a valid way to
  // push the EXIF segment past the first read without corrupting the image.
  const segments: Buffer[] = []
  let remaining = paddingBytes
  while (remaining > 0) {
    const payload = Math.min(remaining, 60_000)
    segments.push(Buffer.from([0xff, 0xfe, ((payload + 2) >> 8) & 0xff, (payload + 2) & 0xff]))
    segments.push(Buffer.alloc(payload, 0x20))
    remaining -= payload
  }
  const body = segments.length === 0 ? base : Buffer.concat([base.subarray(0, 2), ...segments, base.subarray(2)])

  return writeFile_(name, body)
}

/** A JPEG large enough to exceed the first window without any padding. */
async function writeLargeJpeg(name: string, exifDate?: string): Promise<string> {
  const width = 1600
  const height = 1200
  const pixels = Buffer.allocUnsafe(width * height * 3)
  let seed = 12345
  for (let index = 0; index < pixels.length; index++) {
    seed = (1103515245 * seed + 12345) >>> 0
    pixels[index] = (seed >>> 13) & 0xff
  }
  const image = sharp(pixels, { raw: { width, height, channels: 3 } }).withExif(
    exifDate ? { IFD2: { DateTimeOriginal: exifDate } } : {}
  )
  const body = await image.jpeg({ quality: 95 }).toBuffer()
  expect(body.length, 'fixture must exceed the first read').toBeGreaterThan(METADATA_FIRST_READ_BYTES)
  return writeFile_(name, body)
}

/** A PNG with no metadata beyond what the encoder always writes. */
async function writePng(name: string, exifDate?: string): Promise<string> {
  const body = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 9, g: 40, b: 200, alpha: 0.5 } }
  })
    .withExif(exifDate ? { IFD2: { DateTimeOriginal: exifDate } } : {})
    .png()
    .toBuffer()
  return writeFile_(name, body)
}

async function writeFile_(name: string, body: Buffer): Promise<string> {
  dir = dir || (await mkdtemp(join(tmpdir(), 'photostream-prefix-')))
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

function readCount(path: string): number {
  return reads.filter((entry) => entry === path).length
}

describe('readImageMetadata', () => {
  it('reads a normal photo once and finds its date', async () => {
    const path = await writeJpeg('near.jpg', '2024:05:06 07:08:09')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('2024-05-06')
    expect(meta.width).toBe(64)
    expect(readCount(path)).toBe(1)
  })

  it('reads further when the EXIF segment sits past the first window', async () => {
    // 120 KB of comments puts the APP1 segment at ~120 KB, well beyond the
    // 64 KB first read: without the fallback this file would be undated.
    const path = await writeJpeg('far.jpg', '2023:11:12 13:14:15', 120_000)
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('2023-11-12')
    expect(meta.width).toBe(64)
    expect(readCount(path)).toBe(2)
  })

  it('does not read twice when the whole file fits in the first window', async () => {
    // A short read means nothing can be further down the file.
    const path = await writeJpeg('small.jpg')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('')
    expect(meta.width).toBe(64)
    expect(readCount(path)).toBe(1)
  })

  it('does not read twice for a large JPEG with no EXIF at all', async () => {
    // The point of the format walk: reaching the start-of-scan marker proves
    // the metadata area is behind us, so a screenshot JPEG — bigger than the
    // window, no EXIF — costs one read instead of two.
    const path = await writeLargeJpeg('screenshot.jpg')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('')
    expect(meta.width).toBe(1600)
    expect(readCount(path)).toBe(1)
  })

  it('reads a large JPEG with EXIF once', async () => {
    // The date is in the metadata area, far from the image data: one read.
    const path = await writeLargeJpeg('profiled.jpg', '2022:02:03 04:05:06')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('2022-02-03')
    expect(readCount(path)).toBe(1)
  })

  it('reads a PNG without EXIF once', async () => {
    // PNG carries EXIF in an `eXIf` chunk, but screenshots have none. Reaching
    // IDAT proves the metadata chunks (which every encoder writes before the
    // image data) are already in the window.
    const path = await writePng('shot.png')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('')
    expect(meta.width).toBe(400)
    expect(readCount(path)).toBe(1)
  })

  it('reads a PNG date from its eXIf chunk', async () => {
    const path = await writePng('dated.png', '2021:09:08 07:06:05')
    const meta = await readImageMetadata(path)

    expect(meta.takenAt).toBe('2021-09-08')
    expect(meta.width).toBe(400)
    expect(readCount(path)).toBe(1)
  })

  it('keeps the first window at 64 KB', async () => {
    // The number itself is a measurement (see the module comment): widening it
    // silently would give back the I/O the two-stage read exists to avoid.
    expect(METADATA_FIRST_READ_BYTES).toBe(64 * 1024)
  })
})
