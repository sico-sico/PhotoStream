/**
 * Reading the EXIF block out of a file prefix without decoding the image.
 *
 * The scan needs two things from every photo: its capture date and its pixel
 * dimensions. The date lives in the EXIF block, which is a small, self-describing
 * region near the start of the file; the dimensions come from the frame header.
 * Neither needs libvips.
 *
 * The first version of the scan used `sharp(buffer).metadata()` for this, which
 * costs a full libvips pipeline per photo. Measured on a 40 000-photo library:
 * 130–184 µs/photo with sharp against 57–90 µs/photo for reading the same prefix
 * and walking it here (the range is the OS file cache warming up) — a 2.3×
 * difference on the one phase that dominates a cold open.
 *
 * The walk also answers "is there anything left to read?". Both containers place
 * all metadata before their image data (JPEG: every APP segment precedes the
 * start of scan; PNG: every metadata chunk precedes IDAT in anything a real
 * encoder writes), so reaching that point proves a second, larger read would
 * find nothing.
 */
export interface ContainerInspection {
  /** Container recognised from the bytes, not from the file extension. */
  format: 'jpeg' | 'png' | 'unknown'
  /** Raw TIFF-structured EXIF block, with its `Exif\0\0` prefix already removed. */
  exif?: Buffer
  /**
   * Whether the buffer reached the end of the metadata area.
   *
   * `false` when the buffer ended inside a segment or chunk, i.e. a bigger read
   * may still contain the EXIF block.
   */
  complete: boolean
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXIF_PREFIX = 'Exif\0\0'

export function inspectContainer(buffer: Buffer): ContainerInspection {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return inspectJpeg(buffer)
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(buffer)
  return { format: 'unknown', complete: false }
}

function inspectJpeg(buffer: Buffer): ContainerInspection {
  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return { format: 'jpeg', complete: false }
    const marker = buffer[offset + 1]
    // Any number of 0xFF bytes may pad a marker.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    offset += 2
    // Start of scan (and, for a JPEG with no scan at all, end of image): the
    // rest of the file holds no metadata.
    if (marker === 0xda || marker === 0xd9) return { format: 'jpeg', complete: true }
    // Standalone markers have no length field (TEM, RSTn, SOI).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 1 >= buffer.length) return { format: 'jpeg', complete: false }
    const length = buffer.readUInt16BE(offset)
    if (length < 2) return { format: 'jpeg', complete: false }
    if (marker === 0xe1 && length > 2 + EXIF_PREFIX.length) {
      const payload = buffer.subarray(offset + 2, offset + length)
      if (payload.toString('latin1', 0, EXIF_PREFIX.length) === EXIF_PREFIX) {
        return {
          format: 'jpeg',
          exif: payload.subarray(EXIF_PREFIX.length),
          complete: true
        }
      }
    }
    offset += length
    if (offset > buffer.length) return { format: 'jpeg', complete: false }
  }
  return { format: 'jpeg', complete: false }
}

function inspectPng(buffer: Buffer): ContainerInspection {
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    // Chunks are at most 2^31-1 bytes; anything else is a misread header.
    if (length > 0x7fffffff) return { format: 'png', complete: false }
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const end = dataStart + length + 4
    if (type === 'eXIf') {
      if (end > buffer.length) return { format: 'png', complete: false }
      const payload = buffer.subarray(dataStart, dataStart + length)
      // The `eXIf` payload is the TIFF structure itself — unlike JPEG's APP1 it
      // carries no `Exif\0\0` prefix, though a few writers add one anyway.
      const exif =
        payload.toString('latin1', 0, Math.min(6, payload.length)) === EXIF_PREFIX
          ? payload.subarray(EXIF_PREFIX.length)
          : payload
      return { format: 'png', exif, complete: true }
    }
    // Image data or the end of the file: no metadata chunk that any reader would
    // honour can follow. (The spec permits `eXIf` after IDAT; libpng, ExifTool,
    // Adobe and Apple all write it before, and a file that does otherwise simply
    // dates from its file time.)
    if (type === 'IDAT' || type === 'IEND') return { format: 'png', complete: true }
    if (end > buffer.length) return { format: 'png', complete: false }
    offset = end
  }
  return { format: 'png', complete: false }
}
