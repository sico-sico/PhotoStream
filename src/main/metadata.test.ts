import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  METADATA_FIRST_READ_BYTES,
  normalizeOrientation,
  readCaptureDate,
  readImageMetadata
} from './metadata'

/**
 * EXIF capture-date parsing.
 *
 * These cover the failure modes that silently produce wrong dates, which are
 * much worse than missing ones: a photo filed on the wrong day is hard to
 * notice and impossible to bulk-correct once the user trusts the wall.
 */

/** Build the shape `exif-reader` produces: a Date plus its raw tag string. */
function tagDate(value: string): Date {
  // exif-reader constructs the Date from wall-clock fields as if they were UTC.
  const [datePart, timePart = '00:00:00'] = value.split(' ')
  const [y, m, d] = datePart.split(/[:-]/).map(Number)
  const [hh, mm, ss] = timePart.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss))
}

describe('readCaptureDate', () => {
  it('uses DateTimeOriginal when present', () => {
    const exif = { Photo: { DateTimeOriginal: tagDate('2006:05:12 21:06:51') } }
    expect(readCaptureDate(exif)).toBe('2006-05-12')
  })

  it('does not shift the day for late-evening shots', () => {
    // A 23:30 shot in UTC+8 would roll over to the next day if the local
    // offset were applied on top of the stored wall-clock time.
    const exif = { Photo: { DateTimeOriginal: tagDate('2024-03-11 23:30:00') } }
    expect(readCaptureDate(exif)).toBe('2024-03-11')
  })

  it('does not shift the day for early-morning shots', () => {
    const exif = { Photo: { DateTimeOriginal: tagDate('2024-03-11 00:05:00') } }
    expect(readCaptureDate(exif)).toBe('2024-03-11')
  })

  it('prefers DateTimeOriginal over the weaker fallbacks', () => {
    const exif = {
      Photo: { DateTimeOriginal: tagDate('2001:01:01 10:00:00'), CreateDate: tagDate('2002:02:02 10:00:00') },
      Image: { DateTime: tagDate('2003:03:03 10:00:00') }
    }
    expect(readCaptureDate(exif)).toBe('2001-01-01')
  })

  it('falls back to CreateDate when DateTimeOriginal is absent', () => {
    const exif = { Photo: { CreateDate: tagDate('2002:02:02 10:00:00') } }
    expect(readCaptureDate(exif)).toBe('2002-02-02')
  })

  it('falls back to the Image section when Photo has no dates', () => {
    const exif = { Photo: {}, Image: { DateTime: tagDate('2003:03:03 10:00:00') } }
    expect(readCaptureDate(exif)).toBe('2003-03-03')
  })

  it('accepts a raw string tag as written by some encoders', () => {
    const exif = { Photo: { DateTimeOriginal: '2019-07-14 08:15:00' } }
    expect(readCaptureDate(exif)).toBe('2019-07-14')
  })

  it('accepts the EXIF colon format as a raw string', () => {
    const exif = { Photo: { DateTimeOriginal: '2019:07:14 08:15:00' } }
    expect(readCaptureDate(exif)).toBe('2019-07-14')
  })

  it('rejects dates before the plausible capture window', () => {
    // A JPEG cannot predate 1900, so anything earlier is placeholder or corrupt
    // data. Reporting "no date" beats filing the photo under the wrong century.
    const exif = { Photo: { DateTimeOriginal: tagDate('1899:11:30 00:00:00') } }
    expect(readCaptureDate(exif)).toBe('')
  })

  it('keeps dates at the edge of the plausible window', () => {
    const exif = { Photo: { DateTimeOriginal: tagDate('1900:01:01 12:00:00') } }
    expect(readCaptureDate(exif)).toBe('1900-01-01')
  })

  it('rejects an invalid calendar date', () => {
    const exif = { Photo: { DateTimeOriginal: '2023-02-30 10:00:00' } }
    expect(readCaptureDate(exif)).toBe('')
  })

  it('returns empty for missing or malformed documents', () => {
    expect(readCaptureDate(null)).toBe('')
    expect(readCaptureDate(undefined)).toBe('')
    expect(readCaptureDate('nope')).toBe('')
    expect(readCaptureDate({})).toBe('')
    expect(readCaptureDate({ Photo: null, Image: undefined })).toBe('')
  })

  it('ignores invalid Date objects', () => {
    expect(readCaptureDate({ Photo: { DateTimeOriginal: new Date('nope') } })).toBe('')
  })
})

describe('normalizeOrientation', () => {
  it('accepts the EXIF range 1-8', () => {
    for (let value = 1; value <= 8; value++) expect(normalizeOrientation(value)).toBe(value)
  })

  it('defaults to 1 for absent or out-of-range values', () => {
    expect(normalizeOrientation(undefined)).toBe(1)
    expect(normalizeOrientation(null)).toBe(1)
    expect(normalizeOrientation(0)).toBe(1)
    expect(normalizeOrientation(9)).toBe(1)
    expect(normalizeOrientation(-1)).toBe(1)
    expect(normalizeOrientation(3.5)).toBe(1)
    expect(normalizeOrientation('4')).toBe(4)
    expect(normalizeOrientation('absurd')).toBe(1)
  })
})

describe('readImageMetadata', () => {
  /** A TIFF whose only tag is `DateTime`, which is enough to count as dated. */
  function datedTiff(): Buffer {
    const tiff = Buffer.alloc(46)
    tiff.write('II', 0, 'latin1')
    tiff.writeUInt16LE(42, 2)
    tiff.writeUInt32LE(8, 4)
    tiff.writeUInt16LE(1, 8) // one entry
    tiff.writeUInt16LE(0x0132, 10) // DateTime
    tiff.writeUInt16LE(2, 12) // ASCII
    tiff.writeUInt32LE(20, 14) // count
    tiff.writeUInt32LE(26, 18) // offset of the string
    tiff.writeUInt32LE(0, 22) // no next IFD
    tiff.write('2026:10:02 12:00:00\0', 26, 'latin1')
    return tiff
  }

  function app1(payload: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), payload])
    const header = Buffer.from([0xff, 0xe1, 0x00, 0x00])
    header.writeUInt16BE(body.length + 2, 2)
    return Buffer.concat([header, body])
  }

  function segment(marker: number, payload: Buffer): Buffer {
    const header = Buffer.from([0xff, marker, 0x00, 0x00])
    header.writeUInt16BE(payload.length + 2, 2)
    return Buffer.concat([header, payload])
  }

  /** A baseline JPEG frame header carrying `width` x `height`. */
  function sof0(width: number, height: number): Buffer {
    const payload = Buffer.alloc(15)
    payload.writeUInt8(8, 0)
    payload.writeUInt16BE(height, 1)
    payload.writeUInt16BE(width, 3)
    payload.writeUInt8(3, 5)
    for (let i = 0; i < 3; i++) {
      payload.writeUInt8(i + 1, 6 + i * 3)
      payload.writeUInt8(0x11, 7 + i * 3)
      payload.writeUInt8(0, 8 + i * 3)
    }
    return segment(0xc0, payload)
  }

  async function withTempJpeg(bytes: Buffer, run: (path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'photostream-metadata-'))
    try {
      const path = join(dir, 'export.jpg')
      await writeFile(path, bytes)
      await run(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('reads dimensions from past the first window, not just the date', async () => {
    /*
     * A Lightroom export: EXIF, a Photoshop block, an ICC profile, and XMP add
     * up to ~68 KB, so the frame header sits beyond the 64 KB first read. The
     * old code stopped at the EXIF block, reported the window as complete, and
     * filed the photo with width = height = 0 — a square tile showing a 3:2
     * bitmap, i.e. black bars above and below, and no zoom level to ask for.
     */
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app1(datedTiff()),
      segment(0xed, Buffer.alloc(40 * 1024, 3)),
      segment(0xe2, Buffer.alloc(30 * 1024, 5)),
      sof0(6854, 4569),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])
    ])
    expect(bytes.length).toBeGreaterThan(METADATA_FIRST_READ_BYTES)

    await withTempJpeg(bytes, async (path) => {
      const meta = await readImageMetadata(path)
      expect(meta.takenAt).toBe('2026-10-02')
      expect(meta.width).toBe(6854)
      expect(meta.height).toBe(4569)
    })
  })
})
