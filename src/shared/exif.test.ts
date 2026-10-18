import { describe, expect, it } from 'vitest'
import {
  buildExifSections,
  formatAperture,
  formatCoordinate,
  formatExposureBias,
  formatExposureTime,
  formatFocalLength
} from './exif'

/**
 * EXIF presentation.
 *
 * These format real camera values for display, so the tests use the awkward
 * cases photographers actually encounter: very fast shutters, integer and
 * fractional apertures, and southern/western coordinates.
 */

describe('formatExposureTime', () => {
  it('shows sub-second exposures as fractions', () => {
    // 0.004 s is how the camera stores it; 1/250 is how it is displayed.
    expect(formatExposureTime(0.004)).toBe('1/250 s')
    expect(formatExposureTime(1 / 8000)).toBe('1/8000 s')
  })

  it('shows full seconds with a unit', () => {
    expect(formatExposureTime(1)).toBe('1 s')
    expect(formatExposureTime(2.5)).toBe('2.5 s')
    expect(formatExposureTime(30)).toBe('30 s')
  })

  it('falls back to milliseconds for a near-second exposure', () => {
    // 1/0.9 would round to "1/1 s", which reads as a full second.
    expect(formatExposureTime(0.9)).toBe('900 ms')
  })

  it('returns empty for missing or invalid values', () => {
    expect(formatExposureTime(undefined)).toBe('')
    expect(formatExposureTime(0)).toBe('')
    expect(formatExposureTime(-1)).toBe('')
    expect(formatExposureTime(Number.NaN)).toBe('')
  })
})

describe('formatAperture', () => {
  it('drops the decimal for whole f-numbers', () => {
    expect(formatAperture(4)).toBe('f/4')
    expect(formatAperture(11)).toBe('f/11')
  })

  it('keeps one decimal otherwise', () => {
    expect(formatAperture(1.8)).toBe('f/1.8')
    expect(formatAperture(2.8)).toBe('f/2.8')
  })

  it('returns empty for missing values', () => {
    expect(formatAperture(undefined)).toBe('')
    expect(formatAperture(0)).toBe('')
  })
})

describe('formatFocalLength', () => {
  it('shows a plain length', () => {
    expect(formatFocalLength(35, undefined)).toBe('35 mm')
  })

  it('adds the equivalent when it differs', () => {
    // A crop body: 35 mm of glass, 52.5 mm of view.
    expect(formatFocalLength(35, 52.5)).toBe('35 mm (53 mm equiv.)')
  })

  it('omits the equivalent when it matches', () => {
    // Full-frame bodies report both numbers identically.
    expect(formatFocalLength(50, 50)).toBe('50 mm')
  })

  it('returns empty for missing values', () => {
    expect(formatFocalLength(undefined, 50)).toBe('')
    expect(formatFocalLength(0, 50)).toBe('')
  })
})

describe('formatCoordinate', () => {
  it('formats a northern latitude', () => {
    expect(formatCoordinate(39.9042, 'lat')).toBe(`39° 54' 15.12" N`)
  })

  it('formats a western longitude with a negative value', () => {
    expect(formatCoordinate(-0.1276, 'lon')).toBe(`0° 7' 39.36" W`)
  })

  it('uses S for a negative latitude', () => {
    expect(formatCoordinate(-33.8688, 'lat')).toBe(`33° 52' 7.68" S`)
  })

  it('rejects out-of-range and missing values', () => {
    expect(formatCoordinate(undefined, 'lat')).toBe('')
    expect(formatCoordinate(200, 'lat')).toBe('')
    expect(formatCoordinate(Number.NaN, 'lon')).toBe('')
  })
})

describe('formatExposureBias', () => {
  it('keeps the sign so the direction is unambiguous', () => {
    expect(formatExposureBias(0.3)).toBe('+0.3 EV')
    expect(formatExposureBias(-0.7)).toBe('-0.7 EV')
  })

  it('omits a zero bias', () => {
    expect(formatExposureBias(0)).toBe('')
    expect(formatExposureBias(undefined)).toBe('')
  })
})

describe('buildExifSections', () => {
  const fallback = { fileName: 'a.jpg', width: 6000, height: 4000 }

  it('drops sections that would be empty', () => {
    // A photo with no GPS must not render an empty "Location" heading.
    const sections = buildExifSections({ make: 'SONY' }, fallback)
    expect(sections.map((s) => s.key)).not.toContain('exif.location')
  })

  it('always includes the file section', () => {
    const sections = buildExifSections({}, fallback)
    const file = sections.find((s) => s.key === 'exif.file')
    expect(file?.fields).toEqual(
      expect.arrayContaining([
        { label: 'exif.fileName', value: 'a.jpg' },
        { label: 'exif.dimensions', value: '6000 × 4000' }
      ])
    )
  })

  it('avoids repeating the maker when the model already contains it', () => {
    // "NIKON CORPORATION" + "NIKON Z 6" reads badly; the body alone is used.
    const sections = buildExifSections({ make: 'NIKON CORPORATION', model: 'NIKON Z 6' }, fallback)
    const camera = sections.find((s) => s.key === 'exif.camera')
    expect(camera?.fields[0].value).toBe('NIKON Z 6')
  })

  it('states when the date came from the file rather than the camera', () => {
    // Otherwise a date that changes whenever the file is copied would be shown
    // as if the camera had recorded it.
    const sections = buildExifSections({}, { ...fallback, dateSource: 'mtime' })
    const file = sections.find((s) => s.key === 'exif.file')
    expect(file?.fields).toContainEqual({ label: 'exif.dateSource', value: 'exif.dateFromFile' })
  })

  it('does not mention the date source for an EXIF date', () => {
    const sections = buildExifSections({}, { ...fallback, dateSource: 'exif' })
    const file = sections.find((s) => s.key === 'exif.file')
    expect(file?.fields.some((f) => f.label === 'exif.dateSource')).toBe(false)
  })

  it('joins the maker and model when they differ', () => {
    const sections = buildExifSections({ make: 'SONY', model: 'ILCE-7M5' }, fallback)
    expect(sections.find((s) => s.key === 'exif.camera')?.fields[0].value).toBe('SONY ILCE-7M5')
  })

  it('groups exposure settings', () => {
    const sections = buildExifSections(
      { focalLength: 35, fNumber: 1.8, exposureTime: 0.004, iso: 400, exposureBias: 0.3 },
      fallback
    )
    const exposure = sections.find((s) => s.key === 'exif.exposure')
    expect(exposure?.fields.map((f) => f.value)).toEqual(['35 mm', 'f/1.8', '1/250 s', '400', '+0.3 EV'])
  })

  it('reports the flash as a message key, not a boolean', () => {
    const sections = buildExifSections({ flash: true }, fallback)
    expect(sections.find((s) => s.key === 'exif.exposure')?.fields[0]).toEqual({
      label: 'exif.flash',
      value: 'exif.flashFired'
    })
  })

  it('shows coordinates and altitude together', () => {
    const sections = buildExifSections({ latitude: 39.9042, longitude: 116.4074, altitude: 43.5 }, fallback)
    const location = sections.find((s) => s.key === 'exif.location')
    expect(location?.fields[0].value).toContain('N')
    expect(location?.fields[1].value).toBe('44 m')
  })

  it('handles unknown dimensions', () => {
    const sections = buildExifSections({}, { fileName: 'a.jpg', width: 0, height: 0 })
    expect(sections.find((s) => s.key === 'exif.file')?.fields[1].value).toBe('—')
  })

  it('trims padding that EXIF writers leave in text fields', () => {
    const sections = buildExifSections({ make: '  SONY  ', lens: 'FE 24-70mm\0' }, fallback)
    expect(sections.find((s) => s.key === 'exif.camera')?.fields[0].value).toBe('SONY')
    expect(sections.find((s) => s.key === 'exif.camera')?.fields[1].value).toBe('FE 24-70mm')
  })
})
