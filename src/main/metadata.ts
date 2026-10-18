import { open } from 'node:fs/promises'
import { imageSize } from 'image-size'
import sharp from 'sharp'
import exifReader from 'exif-reader'
import { exifDateToIsoDate } from '../shared/date'
import type { RawExif } from '../shared/exif'

/**
 * Reading capture metadata.
 *
 * Measured on a 3226-photo Lightroom export: a 512 KB prefix is the smallest
 * read that parses every file (64 KB missed 151 of them because the EXIF
 * segment sits past it), and the whole pass costs ~1.1 ms per photo.
 *
 * EXIF is the authoritative source for the capture date. The file name is *not*
 * used: it is a caption the photographer typed, absent or wrong for plenty of
 * libraries, and unusable outside the one export preset that writes it.
 *
 * Lightroom already bakes rotation into the pixels, so EXIF `Orientation` is
 * normally absent; `width`/`height` are therefore the display dimensions. Raw
 * EXIF in these exports carries no pixel dimensions, so `image-size` supplies
 * them from the same buffer.
 */
export const METADATA_PREFIX_BYTES = 512 * 1024

/**
 * libvips keeps decoded images and mapped source files in a process-wide cache.
 * On Windows that leaves photos locked, so a Lightroom re-export over the same
 * file name fails with "unable to open for write" while the wall is open.
 * `sharp.cache(false)` is the only setting that releases the handle (verified
 * against every `sharp()` option combination), so it is applied once here as
 * well as in `thumbnails.ts` — both modules load before any photo is touched.
 */
sharp.cache(false)

/** EXIF tags that can carry a capture time, strongest first. */
const CAPTURE_DATE_TAGS = ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'DateTime'] as const

export interface ImageMetadata {
  width: number
  height: number
  /** Local capture date, `YYYY-MM-DD`; empty when EXIF has nothing usable. */
  takenAt: string
  /** EXIF `Orientation` (1-8), or 1 when absent. */
  orientation: number
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Convert an EXIF time to a calendar day.
 *
 * `exif-reader` turns the tag into a `Date` built from the *wall-clock* fields
 * as if they were UTC. Reading it back with `getUTC*` therefore reproduces the
 * moment the shutter fired; using `getFullYear()` and friends would apply the
 * local offset a second time and shift the day. This was verified against 400
 * files whose names encode the same date: `getUTC*` matched all 400, local
 * accessors matched none.
 */
/**
 * Earliest year treated as a real capture date.
 *
 * EXIF defines `0000:00:00 00:00:00` as "time unknown", but `exif-reader`
 * converts it through `Date.UTC`, which interprets year 0 / month -1 as
 * 1899-11-30 — indistinguishable from a genuine date by shape alone. Rather
 * than re-implement TIFF parsing just to see the raw string, dates before 1900
 * are treated as unknown: a JPEG cannot have been captured then, so any such
 * value in this library is a placeholder or corrupt data. Showing "no date" is
 * a far better failure than filing a photo under the wrong century.
 */
const MIN_PLAUSIBLE_YEAR = 1900

function dateToIsoDate(date: unknown): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const year = date.getUTCFullYear()
  if (year < MIN_PLAUSIBLE_YEAR) return ''

  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  return exifDateToIsoDate(`${year}-${pad(month)}-${pad(day)} 00:00:00`)
}

/**
 * Pull the capture date out of a parsed EXIF document.
 *
 * Falls back through progressively weaker tags, then through the raw value in
 * case a writer stored the date as text instead of a structured field. Returns
 * `''` rather than a guess when nothing is usable.
 */
export function readCaptureDate(exif: unknown): string {
  if (!exif || typeof exif !== 'object') return ''
  const document = exif as Record<string, unknown>
  const sections = [document['Photo'], document['Image']].filter(
    (section): section is Record<string, unknown> => Boolean(section) && typeof section === 'object'
  )

  for (const section of sections) {
    for (const tag of CAPTURE_DATE_TAGS) {
      const value = section[tag]
      const iso = dateToIsoDate(value) || exifDateToIsoDate(value)
      if (iso) return iso
    }
  }

  return ''
}

/** Normalise EXIF orientation into the 1-8 range, defaulting to 1. */
export function normalizeOrientation(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1
}

/**
 * Parse width/height, capture date and orientation from a buffer.
 * Never throws: a corrupt file yields whatever could be recovered.
 */
export async function parseImageBuffer(buffer: Buffer): Promise<ImageMetadata> {
  let width = 0
  let height = 0
  let takenAt = ''
  let orientation = 1

  // `sharp.metadata()` understands the container and exposes the raw EXIF
  // block, which `exif-reader` then decodes.
  try {
    const metadata = await sharp(buffer).metadata()
    orientation = normalizeOrientation(metadata.orientation)
    if (metadata.exif) {
      try {
        takenAt = readCaptureDate(exifReader(metadata.exif))
      } catch {
        // Malformed EXIF: the photo stays in the wall, undated.
      }
    }
  } catch {
    // Unreadable image data; dimensions fall through to image-size below.
  }

  try {
    const size = imageSize(buffer)
    width = size.width ?? 0
    height = size.height ?? 0
  } catch {
    // Truncated or unusual JPEG: leave the dimensions at 0 and let the UI
    // fall back to a square placeholder.
  }

  return { width, height, takenAt, orientation }
}

/** Read metadata for a single file from disk. */
export async function readImageMetadata(path: string): Promise<ImageMetadata> {
  const buffer = await readPrefix(path, METADATA_PREFIX_BYTES)
  return parseImageBuffer(buffer)
}

/**
 * Read every EXIF field the detail panel shows.
 *
 * Separate from `readImageMetadata` on purpose: the scan runs this over thousands
 * of files and only needs the date, while the panel opens for one photo at a
 * time and can afford a full parse. Keeping them apart is what stops the scan
 * from paying for fields nobody has asked to see yet.
 */
export async function readFullExif(path: string): Promise<RawExif> {
  const buffer = await readPrefix(path, METADATA_PREFIX_BYTES)
  let document: Record<string, unknown> = {}

  try {
    const metadata = await sharp(buffer).metadata()
    if (metadata.exif) {
      document = exifReader(metadata.exif) as unknown as Record<string, unknown>
    }
  } catch {
    // No readable EXIF: the panel still shows the file-level rows.
    return {}
  }

  // `exif-reader` groups tags by IFD. Photo holds most capture settings, Image
  // holds the maker and software, GPS holds the position.
  const photo = section(document, 'Photo')
  const image = section(document, 'Image')
  const gps = section(document, 'GPS')

  return {
    make: text(image['Make'] ?? photo['Make']),
    model: text(image['Model'] ?? photo['Model']),
    lens: text(photo['LensModel'] ?? photo['LensMake']),
    focalLength: number(photo['FocalLength']),
    focalLength35: number(photo['FocalLengthIn35mmFilm']),
    fNumber: number(photo['FNumber'] ?? photo['ApertureValue']),
    exposureTime: number(photo['ExposureTime']),
    iso: number(photo['ISOSpeedRatings'] ?? photo['PhotographicSensitivity']),
    exposureBias: number(photo['ExposureBiasValue']),
    flash: flashFired(photo['Flash']),
    meteringMode: METERING_MODES[number(photo['MeteringMode']) ?? -1],
    whiteBalance: WHITE_BALANCE_MODES[number(photo['WhiteBalance']) ?? -1],
    latitude: coordinate(gps['GPSLatitude'], gps['GPSLatitudeRef'], 'lat'),
    longitude: coordinate(gps['GPSLongitude'], gps['GPSLongitudeRef'], 'lon'),
    altitude: number(gps['GPSAltitude']),
    capturedAt: timestamp(photo['DateTimeOriginal'] ?? photo['CreateDate'] ?? image['DateTime']),
    software: text(image['Software'])
  }
}

function section(document: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = document[name]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Writers pad these fields with spaces and NULs.
  const trimmed = value.replace(/\0+$/, '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  // Some tags arrive as [numerator, denominator].
  if (Array.isArray(value) && value.length === 2) {
    const [numerator, denominator] = value.map(Number)
    return denominator ? numerator / denominator : undefined
  }
  return undefined
}

/** EXIF Flash is a bit field; bit 0 records whether the flash fired. */
function flashFired(value: unknown): boolean | undefined {
  const flag = number(value)
  return flag === undefined ? undefined : (flag & 1) === 1
}

/**
 * Rebuild the local wall-clock time the camera recorded.
 *
 * `exif-reader` builds the `Date` from the wall-clock fields as if they were
 * UTC, so reading it back with the UTC accessors reproduces the original
 * timestamp without a timezone shift.
 */
function timestamp(value: unknown): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return typeof value === 'string' ? value.trim() || undefined : undefined
  }
  const year = value.getUTCFullYear()
  if (year < MIN_PLAUSIBLE_YEAR) return undefined
  return (
    `${year}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ` +
    `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
  )
}

const METERING_MODES: Record<number, string> = {
  0: 'Unknown',
  1: 'Average',
  2: 'Centre-weighted average',
  3: 'Spot',
  4: 'Multi-spot',
  5: 'Pattern',
  6: 'Partial'
}

const WHITE_BALANCE_MODES: Record<number, string> = {
  0: 'Auto',
  1: 'Manual'
}

/**
 * Convert an EXIF GPS rational triple into decimal degrees.
 *
 * `exif-reader` may hand back either a pre-computed decimal or the raw
 * [degrees, minutes, seconds] array depending on the file's EXIF version, so
 * both shapes are accepted.
 */
function coordinate(value: unknown, reference: unknown, axis: 'lat' | 'lon'): number | undefined {
  let decimal: number | undefined

  if (Array.isArray(value) && value.length === 3) {
    const [degrees, minutes, seconds] = value.map((part) => number(part) ?? 0)
    decimal = degrees + minutes / 60 + seconds / 3600
  } else {
    decimal = number(value)
  }

  if (decimal === undefined || !Number.isFinite(decimal)) return undefined

  const ref = text(reference)?.toUpperCase()
  const negative = ref === 'S' || ref === 'W'
  const magnitude = Math.abs(decimal)
  const limit = axis === 'lat' ? 90 : 180
  if (magnitude > limit) return undefined
  return negative ? -magnitude : magnitude
}
