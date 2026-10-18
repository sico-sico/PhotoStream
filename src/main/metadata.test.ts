import { describe, expect, it } from 'vitest'
import { normalizeOrientation, readCaptureDate } from './metadata'

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
