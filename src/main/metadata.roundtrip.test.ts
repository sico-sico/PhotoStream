import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import exifReader from 'exif-reader'
import { readCaptureDate } from './metadata'

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
