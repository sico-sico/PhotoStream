/**
 * The full EXIF detail shown in the viewer's info panel.
 *
 * Scanning only keeps the fields the wall needs (date and dimensions), because
 * a scan reads 3226 files and every extra field costs memory on all of them.
 * The detail panel is opened for one photo at a time, so it parses on demand and
 * formats the result for display.
 */

/** One labelled row, ready to render. */
export interface ExifField {
  label: string
  value: string
}

/** A group of related rows, so the panel can use headings. */
export interface ExifSection {
  /** Message key for the section heading. */
  key: ExifSectionKey
  fields: ExifField[]
}

export type ExifSectionKey = 'exif.camera' | 'exif.exposure' | 'exif.location' | 'exif.file'

/**
 * Raw values as read from the file, already unwrapped from EXIF's tagged form.
 *
 * Every field is optional: real libraries contain photos from phones with no
 * lens, scans with no camera, and exports that strip GPS.
 */
export interface RawExif {
  make?: string
  model?: string
  lens?: string
  /** Focal length in mm. */
  focalLength?: number
  /** 35mm-equivalent focal length in mm. */
  focalLength35?: number
  /** f-number, e.g. 1.8. */
  fNumber?: number
  /** Exposure time in seconds, e.g. 0.004. */
  exposureTime?: number
  /** ISO speed. */
  iso?: number
  /** Exposure bias in EV. */
  exposureBias?: number
  /** Flash fired, when known. */
  flash?: boolean
  /** Metering mode name, already humanised. */
  meteringMode?: string
  /** White balance mode name. */
  whiteBalance?: string
  /** GPS position in decimal degrees. */
  latitude?: number
  longitude?: number
  /** Altitude in metres. */
  altitude?: number
  /** `YYYY-MM-DD HH:mm:ss` local capture time, when the file has one. */
  capturedAt?: string
  software?: string
}

/**
 * Normalise a text field from EXIF.
 *
 * Writers pad these fields to a fixed length: NUL bytes, trailing spaces, or
 * both. Left in place they render as boxes in the panel and break equality
 * checks, so they are stripped here rather than in every consumer.
 */
const clean = (value: string | undefined): string => (value ?? '').replace(/\0+$/, '').trim()

/**
 * Format an exposure time the way cameras display it.
 *
 * Sub-second exposures read better as fractions ("1/250") than as 0.004, and
 * long exposures as seconds ("2.5 s") rather than an awkward fraction.
 */
export function formatExposureTime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds >= 1) {
    // Trim pointless decimals: 2 s, not 2.00 s.
    const rounded = Math.round(seconds * 10) / 10
    return `${rounded} s`
  }
  const denominator = Math.round(1 / seconds)
  // Guard against 1/0.9 rounding to 1/1, which would read as a full second.
  if (denominator < 2) return `${Math.round(seconds * 1000)} ms`
  return `1/${denominator} s`
}

/** Format an f-number as "f/1.8", keeping one decimal only when needed. */
export function formatAperture(fNumber: number | undefined): string {
  if (typeof fNumber !== 'number' || !Number.isFinite(fNumber) || fNumber <= 0) return ''
  const rounded = Math.round(fNumber * 10) / 10
  return `f/${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`
}

/** Format a focal length, adding the 35mm equivalent when it differs. */
export function formatFocalLength(mm: number | undefined, equivalent: number | undefined): string {
  if (typeof mm !== 'number' || !Number.isFinite(mm) || mm <= 0) return ''
  const base = `${Math.round(mm)} mm`
  if (typeof equivalent !== 'number' || !Number.isFinite(equivalent) || equivalent <= 0) return base
  // Many bodies report the equivalent equal to the real length; showing both
  // then is noise.
  if (Math.abs(Math.round(equivalent) - Math.round(mm)) < 0.5) return base
  return `${base} (${Math.round(equivalent)} mm equiv.)`
}

/** Format decimal degrees as the DMS form photographers expect. */
export function formatCoordinate(value: number | undefined, axis: 'lat' | 'lon'): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 180) return ''
  const hemisphere =
    axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  const absolute = Math.abs(value)
  const degrees = Math.floor(absolute)
  const minutesFloat = (absolute - degrees) * 60
  const minutes = Math.floor(minutesFloat)
  const seconds = (minutesFloat - minutes) * 60
  return `${degrees}° ${minutes}' ${seconds.toFixed(2)}" ${hemisphere}`
}

/** Exposure bias, including the sign: "+0.3 EV" reads correctly, "0.3 EV" does not. */
export function formatExposureBias(ev: number | undefined): string {
  if (typeof ev !== 'number' || !Number.isFinite(ev) || ev === 0) return ''
  const sign = ev > 0 ? '+' : ''
  return `${sign}${Math.round(ev * 10) / 10} EV`
}

/**
 * Build the panel's sections from raw values.
 *
 * Empty sections are dropped rather than rendered with no rows, so a photo shot
 * on a phone without GPS does not show an empty "Location" heading.
 */
export function buildExifSections(raw: RawExif, fallback: { fileName: string; width: number; height: number }): ExifSection[] {
  const camera: ExifField[] = []
  const make = clean(raw.make)
  const model = clean(raw.model)
  // Camera bodies usually repeat the maker in the model ("NIKON Z 6" from
  // "NIKON CORPORATION"), so the body alone is shown when it already says it.
  const body = model && make && model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? model : [make, model].filter(Boolean).join(' ')
  if (body) camera.push({ label: 'exif.make', value: body })
  const lens = clean(raw.lens)
  if (lens) camera.push({ label: 'exif.lens', value: lens })

  const exposure: ExifField[] = []
  const focal = formatFocalLength(raw.focalLength, raw.focalLength35)
  if (focal) exposure.push({ label: 'exif.focalLength', value: focal })
  const aperture = formatAperture(raw.fNumber)
  if (aperture) exposure.push({ label: 'exif.aperture', value: aperture })
  const shutter = formatExposureTime(raw.exposureTime)
  if (shutter) exposure.push({ label: 'exif.shutter', value: shutter })
  if (typeof raw.iso === 'number' && raw.iso > 0) exposure.push({ label: 'exif.iso', value: String(Math.round(raw.iso)) })
  const bias = formatExposureBias(raw.exposureBias)
  if (bias) exposure.push({ label: 'exif.exposureBias', value: bias })
  if (typeof raw.flash === 'boolean') {
    exposure.push({ label: 'exif.flash', value: raw.flash ? 'exif.flashFired' : 'exif.flashOff' })
  }
  const metering = clean(raw.meteringMode)
  if (metering) exposure.push({ label: 'exif.metering', value: metering })
  const whiteBalance = clean(raw.whiteBalance)
  if (whiteBalance) exposure.push({ label: 'exif.whiteBalance', value: whiteBalance })
  const captured = clean(raw.capturedAt)
  if (captured) exposure.push({ label: 'exif.capturedAt', value: captured })

  const location: ExifField[] = []
  const latitude = formatCoordinate(raw.latitude, 'lat')
  const longitude = formatCoordinate(raw.longitude, 'lon')
  if (latitude && longitude) location.push({ label: 'exif.coordinates', value: `${latitude}, ${longitude}` })
  if (typeof raw.altitude === 'number' && Number.isFinite(raw.altitude)) {
    location.push({ label: 'exif.altitude', value: `${Math.round(raw.altitude)} m` })
  }

  const file: ExifField[] = [
    { label: 'exif.fileName', value: fallback.fileName },
    {
      label: 'exif.dimensions',
      value: fallback.width > 0 && fallback.height > 0 ? `${fallback.width} × ${fallback.height}` : '—'
    }
  ]
  const software = clean(raw.software)
  if (software) file.push({ label: 'exif.software', value: software })

  return [
    { key: 'exif.camera' as const, fields: camera },
    { key: 'exif.exposure' as const, fields: exposure },
    { key: 'exif.location' as const, fields: location },
    { key: 'exif.file' as const, fields: file }
  ].filter((section) => section.fields.length > 0)
}
