import { describe, expect, it } from 'vitest'
import { fileModifiedDate, isValidDate, exifDateToIsoDate, normalizeDateBound, resolvePhotoDate } from './date'

describe('isValidDate', () => {
  it('accepts real dates', () => {
    expect(isValidDate(2024, 3, 11)).toBe(true)
    expect(isValidDate(2000, 2, 29)).toBe(true)
  })

  it('rejects impossible calendar dates', () => {
    expect(isValidDate(2023, 2, 29)).toBe(false)
    expect(isValidDate(2023, 4, 31)).toBe(false)
    expect(isValidDate(2023, 13, 1)).toBe(false)
    expect(isValidDate(2023, 0, 1)).toBe(false)
    expect(isValidDate(2023, 1, 0)).toBe(false)
    expect(isValidDate(2023, 1, 32)).toBe(false)
  })

  it('handles century leap-year rules', () => {
    expect(isValidDate(1900, 2, 29)).toBe(false)
    expect(isValidDate(1600, 2, 29)).toBe(true)
  })

  it('rejects out-of-range years and non-integers', () => {
    expect(isValidDate(999, 1, 1)).toBe(false)
    expect(isValidDate(10000, 1, 1)).toBe(false)
    expect(isValidDate(2023.5, 1, 1)).toBe(false)
  })
})

describe('exifDateToIsoDate', () => {
  it('parses the EXIF colon format', () => {
    expect(exifDateToIsoDate('2006:05:12 21:06:51')).toBe('2006-05-12')
  })

  it('parses the ISO-ish format', () => {
    expect(exifDateToIsoDate('2006-05-12 21:06:51')).toBe('2006-05-12')
  })

  it('accepts a T separator and fractional seconds', () => {
    expect(exifDateToIsoDate('2006-05-12T21:06:51.123')).toBe('2006-05-12')
  })

  it('pads single-digit months and days', () => {
    expect(exifDateToIsoDate('2006:5:2 01:02:03')).toBe('2006-05-02')
  })

  it('keeps late-evening times on the same day', () => {
    expect(exifDateToIsoDate('2024:03:11 23:59:59')).toBe('2024-03-11')
  })

  it('keeps midnight on the same day', () => {
    expect(exifDateToIsoDate('2024:03:11 00:00:00')).toBe('2024-03-11')
  })

  it('rejects the all-zero placeholder', () => {
    expect(exifDateToIsoDate('0000:00:00 00:00:00')).toBe('')
  })

  it('rejects invalid times', () => {
    expect(exifDateToIsoDate('2024:03:11 24:00:00')).toBe('')
    expect(exifDateToIsoDate('2024:03:11 12:60:00')).toBe('')
  })

  it('rejects non-strings and garbage', () => {
    expect(exifDateToIsoDate(undefined)).toBe('')
    expect(exifDateToIsoDate(null)).toBe('')
    expect(exifDateToIsoDate(20240311)).toBe('')
    expect(exifDateToIsoDate('yesterday')).toBe('')
  })
})

describe('normalizeDateBound', () => {
  it('passes through a valid bound', () => {
    expect(normalizeDateBound('2024-03-11')).toBe('2024-03-11')
  })

  it('pads a loosely typed bound', () => {
    expect(normalizeDateBound('2024-3-1')).toBe('2024-03-01')
  })

  it('returns empty for blank or invalid input', () => {
    expect(normalizeDateBound('')).toBe('')
    expect(normalizeDateBound('   ')).toBe('')
    expect(normalizeDateBound('2024-02-30')).toBe('')
    expect(normalizeDateBound('11/03/2024')).toBe('')
  })
})

describe('fileModifiedDate', () => {
  it('reads the calendar day in local time', () => {
    // Midday leaves no room for a timezone offset to move the day.
    expect(fileModifiedDate(new Date(2019, 6, 14, 12, 0, 0).getTime())).toBe('2019-07-14')
    expect(fileModifiedDate(new Date(2024, 0, 1, 12, 0, 0).getTime())).toBe('2024-01-01')
  })

  it('returns empty for a timestamp that cannot be a real date', () => {
    expect(fileModifiedDate(0)).toBe('')
    expect(fileModifiedDate(-1)).toBe('')
    expect(fileModifiedDate(Number.NaN)).toBe('')
  })
})

describe('resolvePhotoDate', () => {
  const mtime = new Date(2021, 4, 12, 12, 0, 0).getTime()

  it('prefers the EXIF date and says so', () => {
    expect(resolvePhotoDate('2019-07-14', mtime)).toEqual({ takenAt: '2019-07-14', dateSource: 'exif' })
  })

  it('falls back to the file date when EXIF has none', () => {
    // A PNG from a screenshot tool carries no EXIF at all; without this the
    // photo would have no place in the timeline.
    expect(resolvePhotoDate('', mtime)).toEqual({ takenAt: '2021-05-12', dateSource: 'mtime' })
  })

  it('reports no date when even the file has none', () => {
    expect(resolvePhotoDate('', 0)).toEqual({ takenAt: '', dateSource: 'none' })
  })
})
