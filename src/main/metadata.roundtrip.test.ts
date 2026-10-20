import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import exifReader from 'exif-reader'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseImageBuffer, readCaptureDate, readImageMetadata } from './metadata'

/**
 * End-to-end EXIF regression using real JPEG bytes.
 *
 * The unit tests above build `Date` objects by hand, which cannot catch a
 * mismatch between what `exif-reader` actually produces and what we assume.
 * This generates a JPEG with a real EXIF block written by libvips and asserts
 * the full path: bytes -> sharp -> exif-reader -> `YYYY-MM-DD`.
 */
async function jpegWithExif(isoDate: string): Promise<Buffer> {
  // `withExif` on the output encoder writes a TIFF-structured EXIF block, which
  // is exactly what sharp exposes through `metadata().exif`.
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 60, b: 90 } }
  })
    .withExif({ IFD0: { DateTime: isoDate }, IFD3: { DateTimeOriginal: isoDate } })
    .jpeg()
    .toBuffer()
}

describe('EXIF round trip through sharp', () => {
  it('reads back the wall-clock date without a timezone shift', async () => {
    const buffer = await jpegWithExif('2024:03:11 23:30:00')

    const metadata = await sharp(buffer).metadata()
    expect(metadata.exif, 'libvips did not write an EXIF block').toBeInstanceOf(Buffer)

    const parsed = exifReader(metadata.exif as Buffer)
    expect(readCaptureDate(parsed)).toBe('2024-03-11')
  })

  it('is stable for a midnight timestamp', async () => {
    // Midnight is the worst case: the tiniest offset shifts the calendar day.
    const buffer = await jpegWithExif('2006:05:12 00:00:00')
    const metadata = await sharp(buffer).metadata()
    expect(readCaptureDate(exifReader(metadata.exif as Buffer))).toBe('2006-05-12')
  })

  it('reports no date for a plain JPEG with no EXIF', async () => {
    const buffer = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } }
    })
      .jpeg()
      .toBuffer()

    const metadata = await sharp(buffer).metadata()
    expect(metadata.exif).toBeUndefined()
    expect(readCaptureDate(undefined)).toBe('')
  })
})

/**
 * The scan no longer hands the buffer to libvips: it walks the container itself
 * (`exif-block.ts`) and decodes the same EXIF block with `exif-reader`. These
 * tests pin that the two routes agree on real files written by libvips, so the
 * replacement cannot silently start reading dates differently.
 */
describe('the hand-written container walk against real files', () => {
  async function jpeg(options: { date?: string } = {}): Promise<Buffer> {
    const image = sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 30, g: 60, b: 90 } }
    })
    if (!options.date) return image.jpeg().toBuffer()
    const exif: Record<string, Record<string, string>> = {
      IFD0: { DateTime: options.date },
      IFD3: { DateTimeOriginal: options.date }
    }
    return image.withExif(exif).jpeg().toBuffer()
  }

  it('reads the same date as sharp for a JPEG with EXIF', async () => {
    const buffer = await jpeg({ date: '2019:08:14 18:22:01' })
    const viaSharp = exifReader((await sharp(buffer).metadata()).exif as Buffer)

    const parsed = await parseImageBuffer(buffer)
    expect(parsed.takenAt).toBe(readCaptureDate(viaSharp))
    expect(parsed.takenAt).toBe('2019-08-14')
    expect(parsed.width).toBe(40)
    expect(parsed.height).toBe(20)
  })

  it('reads orientation from the EXIF block', async () => {
    // Lightroom bakes rotation into the pixels, so orientation is normally
    // absent; when a camera writes it, the wall still has to honour it.
    const buffer = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 30, g: 60, b: 90 } }
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    // Same route libvips took: it reports the tag it wrote.
    expect((await sharp(buffer).metadata()).orientation).toBe(6)
    expect((await parseImageBuffer(buffer)).orientation).toBe(6)
  })

  it('still reports dimensions for a JPEG with no EXIF', async () => {
    const parsed = await parseImageBuffer(await jpeg())
    expect(parsed).toEqual({ width: 40, height: 20, takenAt: '', orientation: 1 })
  })

  it('reads a PNG eXIf chunk', async () => {
    // PNG gained a standard EXIF chunk in 1.5, and libvips writes it.
    const buffer = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .withExif({ IFD0: { DateTime: '2018:01:02 03:04:05' }, IFD3: { DateTimeOriginal: '2018:01:02 03:04:05' } })
      .png()
      .toBuffer()

    const parsed = await parseImageBuffer(buffer)
    expect(parsed.takenAt).toBe('2018-01-02')
    expect(parsed.width).toBe(32)
    expect(parsed.height).toBe(24)
  })

  it('matches sharp for a file read from disk', async () => {
    // The path the scan actually takes: one 64 KB prefix, parsed without libvips.
    const buffer = await jpeg({ date: '2004:11:30 09:00:00' })
    const dir = await mkdtemp(join(tmpdir(), 'photostream-roundtrip-'))
    try {
      const path = join(dir, 'a.jpg')
      await writeFile(path, buffer)
      expect((await readImageMetadata(path)).takenAt).toBe('2004-11-30')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
