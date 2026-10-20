import { open } from 'node:fs/promises'
import { imageSize } from 'image-size'
import exifReader from 'exif-reader'
import { loadSharp } from './sharp-loader'
import { inspectContainer } from './exif-block'
import { exifDateToIsoDate } from '../shared/date'
import type { RawExif } from '../shared/exif'

/**
 * Reading capture metadata.
 *
 * Measured on a 3226-photo Lightroom export: a 512 KB prefix is the smallest
 * read that parses every file (64 KB missed 151 of them because the EXIF
 * segment sits past it), and the whole pass costs ~1.1 ms per photo.
 *
 * Reading 512 KB for every photo was pure waste for the other 95%: their EXIF
 * segment sits in the first few kilobytes. `readImageMetadata` therefore reads
 * `METADATA_FIRST_READ_BYTES` first and only pays for the rest when that read
 * yielded no date *and* may still have metadata ahead of it (see
 * `metadataRegionComplete`). Measured on 200 3–5 MB JPEGs, the two-stage read
 * costs 0.84 ms/photo instead of 1.02 ms and reads 13 MB instead of 100 MB — the
 * I/O matters more than the CPU, because every one of those bytes is scanned by
 * Defender on access (see docs/architecture.md). A PNG screenshot library is the
 * bigger win, since PNGs have no EXIF to find: 1.52 → 0.38 ms/photo.
 *
 * EXIF is the authoritative source for the capture date. The file name is *not*
 * used: it is a caption the photographer typed, absent or wrong for plenty of
 * libraries, and unusable outside the one export preset that writes it.
 *
 * Nothing here goes through libvips. `sharp(buffer).metadata()` was the obvious
 * way to read the block and costs a full decode pipeline per photo: measured on
 * a 40 000-photo cold scan, 184 µs/photo against 90 µs/photo when the container
 * is walked here and only the EXIF block is handed to `exif-reader`. On the one
 * phase that dominates a first open that difference is 3.6 s. `sharp` is still
 * the fallback for a file whose contents disagree with its extension.
 *
 * Lightroom already bakes rotation into the pixels, so EXIF `Orientation` is
 * normally absent; `width`/`height` are therefore the display dimensions. Raw
 * EXIF in these exports carries no pixel dimensions, so `image-size` supplies
 * them from the same buffer.
 */
export const METADATA_PREFIX_BYTES = 512 * 1024

/**
 * First read of a scan.
 *
 * 64 KB covers the EXIF segment of ~95% of a real library. The remaining files
 * are detected by the *absence* of a date plus a full first read (a short read
 * means the file itself is smaller than the window, so nothing is missing).
 */
export const METADATA_FIRST_READ_BYTES = 64 * 1024

/**
 * Whether the first window already reached the end of the file's metadata area.
 *
 * "No date" is not the same as "the date may be further down". Both accepted
 * formats have a point after which no metadata can appear, and a window that
 * reaches it proves the absence of EXIF — so a screenshot JPEG or PNG, which
 * has none at all, does not pay for a second read.
 *
 * The walk itself lives in `exif-block.ts`, which is also what extracts the EXIF
 * block; this is the one flag the scan needs from it.
 */
export function metadataRegionComplete(buffer: Buffer): boolean {
  return inspectContainer(buffer).complete
}

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
 *
 * The EXIF block and the frame header are both plain structures near the start
 * of the file, so this walks the container instead of handing it to libvips.
 * See `exif-block.ts` for why that is worth a hand-written parser.
 */
export async function parseImageBuffer(buffer: Buffer): Promise<ImageMetadata> {
  let width = 0
  let height = 0
  let takenAt = ''
  let orientation = 1

  const inspection = inspectContainer(buffer)
  if (inspection.format === 'unknown') {
    // A file whose contents disagree with its extension. Rare, and not worth a
    // parser of its own: let libvips identify it.
    try {
      const sharp = await loadSharp()
      const metadata = await sharp(buffer).metadata()
      width = metadata.width ?? 0
      height = metadata.height ?? 0
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
  } else if (inspection.exif) {
    try {
      const document = exifReader(inspection.exif) as Record<string, unknown>
      takenAt = readCaptureDate(document)
      const image = document['Image']
      orientation = normalizeOrientation(
        image && typeof image === 'object'
          ? (image as Record<string, unknown>)['Orientation']
          : undefined
      )
    } catch {
      // Malformed EXIF: the photo stays in the wall, undated.
    }
  }

  if (width === 0 || height === 0) {
    try {
      const size = imageSize(buffer)
      width = size.width ?? 0
      height = size.height ?? 0
    } catch {
      // Truncated or unusual JPEG: leave the dimensions at 0 and let the UI
      // fall back to a square placeholder.
    }
  }

  return { width, height, takenAt, orientation }
}

/** Read metadata for a single file from disk. */
export async function readImageMetadata(path: string): Promise<ImageMetadata> {
  const first = await readPrefix(path, METADATA_FIRST_READ_BYTES)
  const meta = await parseImageBuffer(first)
  // A short read means the file itself fits in the window: there is nothing
  // further to look at.
  if (first.length < METADATA_FIRST_READ_BYTES) return meta
  // Done when both answers are in hand, or when the window provably reached the
  // end of the metadata area (see `metadataRegionComplete`).
  //
  // Dimensions are part of the condition, not just the date. A file whose APP
  // segments add up to more than 64 KB — a camera JPEG with a large XMP block
  // and an ICC profile puts its frame header past 68 KB — yields a date but no
  // width or height from the first window, and returning here would file it as
  // a square photo: the tile then letterboxes the real 3:2 bitmap, which reads
  // as black bars above and below the picture.
  if (meta.takenAt && meta.width > 0 && meta.height > 0) return meta
  if (metadataRegionComplete(first)) return meta

  const full = await readPrefix(path, METADATA_PREFIX_BYTES)
  return parseImageBuffer(full)
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

  const inspection = inspectContainer(buffer)
  try {
    if (inspection.exif) {
      document = exifReader(inspection.exif) as unknown as Record<string, unknown>
    } else if (inspection.format === 'unknown') {
      const sharp = await loadSharp()
      const metadata = await sharp(buffer).metadata()
      if (metadata.exif) {
        document = exifReader(metadata.exif) as unknown as Record<string, unknown>
      }
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
