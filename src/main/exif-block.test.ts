import { describe, expect, it } from 'vitest'
import { inspectContainer } from './exif-block'

/**
 * The container walk that replaced `sharp.metadata()` in the scan.
 *
 * It has to answer two questions from a prefix: where is the EXIF block, and is
 * there any point reading further? Both are decided by the container's own
 * structure, so these tests build the bytes by hand — a real file cannot easily
 * be made to put its EXIF segment past 64 KB, or its PNG chunk after IDAT.
 */

/** An APP1 segment carrying `payload` after the `Exif\0\0` header. */
function app1(payload: Buffer, withHeader = true): Buffer {
  const body = withHeader ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), payload]) : payload
  const header = Buffer.from([0xff, 0xe1, 0x00, 0x00])
  header.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([header, body])
}

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0x00, 0x00])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

const SOI = Buffer.from([0xff, 0xd8])
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x02])

/** A PNG chunk, with its length, type and CRC. */
function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload, Buffer.alloc(4)])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TIFF = Buffer.from('MM\0*\0\0\0\x08', 'latin1')

describe('inspectContainer: JPEG', () => {
  it('returns the EXIF block with the Exif header stripped', () => {
    const jpeg = Buffer.concat([SOI, app1(TIFF), SOS])
    const inspection = inspectContainer(jpeg)

    expect(inspection.format).toBe('jpeg')
    expect(inspection.exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
    expect(inspection.complete).toBe(true)
  })

  it('skips other APP segments to find APP1', () => {
    // A JFIF header and an ICC profile both sit before the EXIF in a real
    // export; the walk must use their declared lengths, not search for a marker.
    const jpeg = Buffer.concat([
      SOI,
      segment(0xe0, Buffer.from('JFIF\0', 'latin1')),
      segment(0xe2, Buffer.alloc(200, 7)),
      app1(TIFF),
      SOS
    ])
    expect(inspectContainer(jpeg).exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
  })

  it('ignores an APP1 that is XMP rather than EXIF', () => {
    const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')
    const jpeg = Buffer.concat([SOI, app1(xmp, false), app1(TIFF), SOS])
    const inspection = inspectContainer(jpeg)

    expect(inspection.exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
  })

  it('reports no EXIF for a JPEG that has none, once the scan starts', () => {
    const jpeg = Buffer.concat([SOI, segment(0xdb, Buffer.alloc(65, 1)), SOS])
    const inspection = inspectContainer(jpeg)

    // Complete: a second, larger read would find nothing, which is what stops a
    // screenshot library from paying for a 512 KB read per file.
    expect(inspection.complete).toBe(true)
    expect(inspection.exif).toBeUndefined()
  })

  it('finds the EXIF behind a large ICC profile', () => {
    // The reason a 64 KB window can miss the date at all: APP segment lengths
    // are 16-bit, but a colour profile spans many of them, pushing the EXIF
    // APP1 past the window.
    const segments = Array.from({ length: 8 }, () => segment(0xe2, Buffer.alloc(60 * 1024, 7)))
    const jpeg = Buffer.concat([SOI, ...segments, app1(TIFF), SOS])

    const window = inspectContainer(jpeg.subarray(0, 64 * 1024))
    expect(window.complete, 'a truncated window must ask for more').toBe(false)
    expect(window.exif).toBeUndefined()

    expect(inspectContainer(jpeg).exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
  })

  it('is incomplete when the window ends after the EXIF block but before the scan', () => {
    /*
     * The bug this covers: finding the EXIF block used to end the walk and
     * report `complete`, so a photo whose date sits in the first 64 KB but whose
     * frame header sits past it never triggered the larger read — and was filed
     * with no dimensions at all.
     *
     * A real export looks exactly like this: APP1(EXIF), APP13(Photoshop), APP2
     * (ICC), APP1(XMP), and only then DQT/SOF, which lands past 68 KB here.
     */
    const jpeg = Buffer.concat([
      SOI,
      app1(TIFF),
      segment(0xed, Buffer.alloc(40 * 1024, 3)),
      segment(0xe2, Buffer.alloc(30 * 1024, 5)),
      segment(0xdb, Buffer.alloc(65, 1)),
      SOS
    ])

    const window = inspectContainer(jpeg.subarray(0, 64 * 1024))
    expect(window.exif?.toString('latin1'), 'the date is already readable').toBe(TIFF.toString('latin1'))
    expect(window.complete, 'but the frame header may be further down').toBe(false)

    expect(inspectContainer(jpeg).complete).toBe(true)
  })

  it('stops at end of image', () => {
    const jpeg = Buffer.concat([SOI, Buffer.from([0xff, 0xd9])])
    expect(inspectContainer(jpeg).complete).toBe(true)
  })

  it('does not mistake an embedded thumbnail for the end of the metadata', () => {
    // An EXIF block can carry a JPEG thumbnail whose own bytes contain `FF DA`.
    // A parser that searched for the start of scan would stop inside the EXIF
    // block and lose the tags after it; this one skips by declared length.
    const payload = Buffer.concat([TIFF, Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])])
    const jpeg = Buffer.concat([SOI, app1(payload), SOS])

    expect(inspectContainer(jpeg).exif?.toString('latin1')).toBe(payload.toString('latin1'))
  })
})

describe('inspectContainer: PNG', () => {
  it('returns the eXIf chunk payload, which has no Exif header', () => {
    const png = Buffer.concat([PNG_SIGNATURE, chunk('eXIf', TIFF), chunk('IDAT', Buffer.alloc(10))])
    const inspection = inspectContainer(png)

    expect(inspection.format).toBe('png')
    expect(inspection.exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
    expect(inspection.complete).toBe(true)
  })

  it('strips an Exif header some writers add anyway', () => {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), TIFF])
    const png = Buffer.concat([PNG_SIGNATURE, chunk('eXIf', payload), chunk('IDAT', Buffer.alloc(10))])
    expect(inspectContainer(png).exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
  })

  it('walks past the chunks that precede the image data', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', Buffer.alloc(13)),
      chunk('iCCP', Buffer.alloc(500)),
      chunk('eXIf', TIFF),
      chunk('IDAT', Buffer.alloc(10))
    ])
    expect(inspectContainer(png).exif?.toString('latin1')).toBe(TIFF.toString('latin1'))
  })

  it('reports no EXIF for a screenshot, once the image data starts', () => {
    const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.alloc(4000))])
    const inspection = inspectContainer(png)

    expect(inspection.complete).toBe(true)
    expect(inspection.exif).toBeUndefined()
  })

  it('is incomplete while the window ends inside a chunk', () => {
    const png = Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', Buffer.alloc(13)),
      chunk('iCCP', Buffer.alloc(100_000))
    ])
    expect(inspectContainer(png.subarray(0, 64 * 1024)).complete).toBe(false)
  })
})

describe('inspectContainer: anything else', () => {
  it('reports an unknown container for bytes that are neither', () => {
    const inspection = inspectContainer(Buffer.from('not an image at all', 'latin1'))
    expect(inspection.format).toBe('unknown')
    expect(inspection.complete).toBe(false)
    expect(inspection.exif).toBeUndefined()
  })

  it('reports an unknown container for an empty buffer', () => {
    expect(inspectContainer(Buffer.alloc(0)).format).toBe('unknown')
  })
})
