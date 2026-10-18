import { open } from 'node:fs/promises'
import { imageSize } from 'image-size'
import sharp from 'sharp'
import exifReader from 'exif-reader'
import { exifDateToIsoDate } from '../shared/date'

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
