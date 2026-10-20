import { describe, expect, it } from 'vitest'
import {
  THUMB_PIPELINE_REVISION,
  THUMB_SHARD_DEPTH,
  THUMB_SIZES,
  VIEWER_EDGE_BUCKET,
  hash64,
  isCurrentRenditionTag,
  parseRenditionTag,
  pickThumbLevel,
  renditionCacheTag,
  thumbKey,
  viewerEdge,
  wallRenditionEdge,
  zoomTierAddsDetail
} from './thumbs'

describe('viewerEdge', () => {
  it('rounds the display size up to the bucket', () => {
    // 1840 device px (a 1227 px box at DPR 1.5) becomes 2048. Serving exactly
    // 1840 would be marginally sharper but would create one cache file per
    // window size.
    expect(viewerEdge(1840)).toBe(2048)
    expect(viewerEdge(1024)).toBe(1024)
    expect(viewerEdge(1025)).toBe(1280)
    expect(viewerEdge(1840)! % VIEWER_EDGE_BUCKET).toBe(0)
  })

  it('does not ask for a rendition below the wall tier', () => {
    // The `wall` file already holds at least this many pixels and is shared with
    // the photo wall, so a second file would be duplication.
    expect(viewerEdge(200)).toBeNull()
    // At or above the wall size the request is served by the wall file itself
    // (the tag collapses to `wall`), so the edge is reported rather than null.
    expect(viewerEdge(300)).toBe(THUMB_SIZES.wall)
    expect(viewerEdge(THUMB_SIZES.wall)).toBe(THUMB_SIZES.wall)
  })

  it('gives up past the largest generated size', () => {
    // Beyond `zoom` the original is the right source: generating a bigger
    // intermediate would add a downscale instead of removing one.
    expect(viewerEdge(THUMB_SIZES.zoom + 1)).toBeNull()
    expect(viewerEdge(THUMB_SIZES.zoom)).toBe(THUMB_SIZES.zoom)
  })

  it('returns null for sizes that cannot describe a box', () => {
    expect(viewerEdge(0)).toBeNull()
    expect(viewerEdge(-5)).toBeNull()
    expect(viewerEdge(Number.NaN)).toBeNull()
    expect(viewerEdge(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('wallRenditionEdge', () => {
  it('keeps the 512px floor for ordinary shapes', () => {
    // These are all painted inside a 512px bitmap at the default zoom: the
    // layout's row height (220) or column width (260) times the aspect ratio.
    expect(wallRenditionEdge(6000, 4000)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(1200, 800)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(800, 1200)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(1920, 1080)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(4000, 2000)).toBe(THUMB_SIZES.wall)
    // A handful of pixels over the floor is not worth a larger file.
    expect(wallRenditionEdge(2200, 1000)).toBe(THUMB_SIZES.wall)
  })

  it('grows with a panorama the wall paints wider than the floor', () => {
    // `grid` fixes the row height at 220px, so the painted width is 220 * a.
    expect(wallRenditionEdge(4000, 1000)).toBe(880)
    expect(wallRenditionEdge(14525, 3798)).toBe(842)
    expect(wallRenditionEdge(5000, 1000)).toBe(1100)
  })

  it('grows with a tall photo, whose long edge is the tile height', () => {
    // `masonry` fixes the column width at 260px, so a 1:2.5 photo is painted
    // 260x650 and a 1:5 photo 260x1300. A 1:2 portrait (520px) stays on the
    // 512px floor: the same tolerance ordinary photos get.
    expect(wallRenditionEdge(1000, 2000)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(1000, 2500)).toBe(650)
    expect(wallRenditionEdge(1000, 5000)).toBe(1300)
  })

  it('clamps broken ratios the way the layout does', () => {
    // A corrupt EXIF height must not ask for a 100 000px rendition.
    expect(wallRenditionEdge(100000, 1000)).toBe(1100)
    expect(wallRenditionEdge(1000, 100000)).toBe(1300)
  })

  it('falls back to the floor when the dimensions are unknown', () => {
    expect(wallRenditionEdge(0, 0)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(-1, 500)).toBe(THUMB_SIZES.wall)
    expect(wallRenditionEdge(Number.NaN, 500)).toBe(THUMB_SIZES.wall)
  })
})

describe('zoomTierAddsDetail', () => {
  it('says a source below the wall size gains nothing from a zoom rendition', () => {
    // Both tiers encode to the source's own pixels because of
    // `withoutEnlargement`, so the second file is the same image twice.
    expect(zoomTierAddsDetail(300, 200)).toBe(false)
    expect(zoomTierAddsDetail(64, 64)).toBe(false)
    // Exactly at the wall size: the wall file already holds every pixel.
    expect(zoomTierAddsDetail(THUMB_SIZES.wall, THUMB_SIZES.wall)).toBe(false)
  })

  it('says a larger source gains detail', () => {
    expect(zoomTierAddsDetail(6000, 4000)).toBe(true)
    expect(zoomTierAddsDetail(6000, 1000)).toBe(true)
  })

  it('compares against the rendition the wall will actually produce', () => {
    // 200x900 is painted 260x1170 in `masonry`, so its wall rendition is the
    // source's own 900px long edge — a zoom file would be a duplicate.
    expect(zoomTierAddsDetail(200, 900)).toBe(false)
    // The same long edge in a 3:2 shape stays inside the 512px wall rendition,
    // so zooming the wall really does gain detail.
    expect(zoomTierAddsDetail(900, 600)).toBe(true)
    // 100x400 never leaves the source size either.
    expect(zoomTierAddsDetail(100, 400)).toBe(false)
  })

  it('keeps the tier when the dimensions are unknown', () => {
    // A scan that could not read the size must not silently downgrade the
    // image; an extra file is cheaper than a permanently soft tile.
    expect(zoomTierAddsDetail(0, 0)).toBe(true)
    expect(zoomTierAddsDetail(-1, 500)).toBe(true)
  })
})

describe('renditionCacheTag', () => {
  it('names everything that determines the bytes', () => {
    expect(renditionCacheTag('wall', 842, 78)).toBe('wall842q78p1')
    expect(renditionCacheTag('zoom', 2560, 82)).toBe('zoom2560q82p1')
    expect(renditionCacheTag('viewer', 1792, 85)).toBe('viewer1792q85p1')
  })

  it('tracks the pipeline revision constant', () => {
    // A golden file: if the pipeline changes but this assertion does not, the
    // cache keeps serving files encoded by the old one. Bumping the revision is
    // what retires them, so the test is deliberately brittle.
    expect(THUMB_PIPELINE_REVISION).toBe(1)
  })
})

describe('parseRenditionTag', () => {
  it('round-trips a tag', () => {
    expect(parseRenditionTag('wall842q78p1')).toEqual({
      kind: 'wall',
      edge: 842,
      quality: 78,
      revision: 1
    })
  })

  it('rejects the pre-0.2.3 names', () => {
    // These are exactly the files the sweeper has to delete: they carry no
    // edge/quality/revision, so nothing can tell how they were encoded.
    expect(parseRenditionTag('wall')).toBeNull()
    expect(parseRenditionTag('wall842')).toBeNull()
    expect(parseRenditionTag('zoom')).toBeNull()
    expect(parseRenditionTag('viewer2048')).toBeNull()
  })

  it('rejects malformed or hostile names', () => {
    expect(parseRenditionTag('')).toBeNull()
    expect(parseRenditionTag('wall0q78p1')).toBeNull()
    expect(parseRenditionTag('wall842q78p')).toBeNull()
    expect(parseRenditionTag('wall842q78p1.webp')).toBeNull()
    expect(parseRenditionTag('wall842q78p01')).not.toBeNull()
  })
})

describe('isCurrentRenditionTag', () => {
  it('accepts what this build writes', () => {
    expect(isCurrentRenditionTag('wall512q78p1')).toBe(true)
    expect(isCurrentRenditionTag('wall842q78p1')).toBe(true)
    expect(isCurrentRenditionTag('zoom2560q82p1')).toBe(true)
    expect(isCurrentRenditionTag('viewer1792q85p1')).toBe(true)
  })

  it('rejects a different quality', () => {
    expect(isCurrentRenditionTag('wall512q82p1')).toBe(false)
    expect(isCurrentRenditionTag('viewer1792q78p1')).toBe(false)
  })

  it('rejects a different pipeline revision', () => {
    expect(isCurrentRenditionTag('wall512q78p0')).toBe(false)
    expect(isCurrentRenditionTag('wall512q78p2')).toBe(false)
  })

  it('rejects an edge this build cannot produce', () => {
    // Below the floor, above the accepted ceiling, or a viewer size that is not
    // one of the 256px buckets.
    expect(isCurrentRenditionTag('wall400q78p1')).toBe(false)
    expect(isCurrentRenditionTag('wall4000q78p1')).toBe(false)
    expect(isCurrentRenditionTag('zoom1280q82p1')).toBe(false)
    expect(isCurrentRenditionTag('viewer1000q85p1')).toBe(false)
    expect(isCurrentRenditionTag('viewer4000q85p1')).toBe(false)
  })
})

describe('pickThumbLevel', () => {
  it('uses the wall level for tiles smaller than the wall rendition', () => {
    expect(pickThumbLevel(240, 1)).toBe('wall')
  })

  it('switches to the zoom level when the tile outgrows the wall rendition', () => {
    expect(pickThumbLevel(240, 3)).toBe('zoom')
  })

  it('switches right at the threshold', () => {
    const threshold = THUMB_SIZES.wall * 0.9
    expect(pickThumbLevel(threshold, 1)).toBe('wall')
    expect(pickThumbLevel(threshold + 1, 1)).toBe('zoom')
  })

  it('serves the original once the zoom level runs out of pixels', () => {
    // This is the fix for blurry tiles: the old code capped out at the 1280px
    // rendition and upscaled beyond it.
    const threshold = THUMB_SIZES.zoom * 0.9
    expect(pickThumbLevel(threshold, 1)).toBe('zoom')
    expect(pickThumbLevel(threshold + 1, 1)).toBe('full')
  })

  it('reaches the original only when the zoom genuinely runs out of pixels', () => {
    // A 240px tile needs 240*scale*dpr pixels. With a 2560px `zoom` rendition
    // the original is not needed until scale ≈ 9.6 — the point of the larger
    // tier: a camera JPEG is often 6000–8000px, six times the pixels of the
    // rendition it replaces, and decoding several of those per gesture is what
    // made rapid zooming stutter.
    expect(pickThumbLevel(240, 3)).toBe('zoom')
    expect(pickThumbLevel(240, 9)).toBe('zoom')
    expect(pickThumbLevel(240, 10)).toBe('full')
  })

  it('reaches the original sooner on a high-DPI display', () => {
    // A 2x display needs twice the pixels, so it crosses into the original at
    // half the zoom.
    expect(pickThumbLevel(240, 5, 1)).toBe('zoom')
    expect(pickThumbLevel(240, 5, 2)).toBe('full')
  })

  it('accounts for the device pixel ratio', () => {
    // 240 * 1 * 2 = 480 > 460.8, so a retina display promotes the rendition.
    expect(pickThumbLevel(240, 1, 1)).toBe('wall')
    expect(pickThumbLevel(240, 1, 2)).toBe('zoom')
  })

  it('treats non-finite input safely', () => {
    // Anything unmeasurable resolves to the cheap rendition rather than
    // triggering a needless high-resolution decode.
    expect(pickThumbLevel(Number.NaN, 1)).toBe('wall')
    expect(pickThumbLevel(Number.POSITIVE_INFINITY, 1)).toBe('wall')
    expect(pickThumbLevel(240, Number.POSITIVE_INFINITY)).toBe('wall')
  })

  it('uses the magnitude of the required pixels', () => {
    // A negative width can only come from a caller bug, but the decision is
    // based on how many pixels are needed, so the sign must not matter.
    expect(pickThumbLevel(-500, 1)).toBe('zoom')
    expect(pickThumbLevel(-100, 1)).toBe('wall')
  })

  it('handles a zero scale', () => {
    expect(pickThumbLevel(1000, 0)).toBe('wall')
  })
})

describe('hash64', () => {
  it('is deterministic', () => {
    expect(hash64('C:\\photos\\a.jpg')).toBe(hash64('C:\\photos\\a.jpg'))
  })

  it('produces 16 hex characters', () => {
    expect(hash64('anything')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for similar inputs', () => {
    expect(hash64('a.jpg')).not.toBe(hash64('b.jpg'))
    expect(hash64('/a/b.jpg')).not.toBe(hash64('/a/c.jpg'))
  })

  it('handles an empty string', () => {
    expect(hash64('')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('handles non-ASCII paths', () => {
    expect(hash64('D:\\照片\\京都.jpg')).toMatch(/^[0-9a-f]{16}$/)
    expect(hash64('D:\\照片\\京都.jpg')).not.toBe(hash64('D:\\照片\\东京.jpg'))
  })
})

describe('thumbKey', () => {
  it('encodes the rendition in the file name', () => {
    expect(thumbKey('/p/a.jpg', 1, 2, 'wall512q78p1')).toMatch(/-wall512q78p1\.webp$/)
    expect(thumbKey('/p/a.jpg', 1, 2, 'zoom2560q82p1')).toMatch(/-zoom2560q82p1\.webp$/)
  })

  it('pins the exact key for a fixed input', () => {
    /*
     * Golden key. The hash and the tag both feed the file name, so this fails
     * the moment anything that determines the encoded bytes changes without the
     * tag changing with it — which is precisely the bug that would make every
     * existing cache entry stale but still be served.
     *
     * If this test fails, do not update the expected string: decide whether the
     * change alters the bytes. If it does, bump `THUMB_PIPELINE_REVISION` (or
     * the quality), which retires the old files; only then update this value.
     */
    expect(thumbKey('C:\\photos\\a.jpg', 1700000000000, 123456, 'wall512q78p1')).toBe(
      '6/9/69127171107a2aec-wall512q78p1.webp'
    )
    expect(thumbKey('C:\\photos\\a.jpg', 1700000000000, 123456, 'zoom2560q82p1')).toBe(
      '3/e/3e3faa8868fa1c62-zoom2560q82p1.webp'
    )
  })

  it('changes when the file changes', () => {
    const base = thumbKey('/p/a.jpg', 1000, 500, 'wall')
    const touched = thumbKey('/p/a.jpg', 2000, 500, 'wall')
    const replaced = thumbKey('/p/a.jpg', 1000, 900, 'wall')
    expect(base).not.toBe(touched)
    expect(base).not.toBe(replaced)
  })

  it('is stable for the same inputs', () => {
    expect(thumbKey('/p/a.jpg', 1000, 500, 'wall')).toBe(thumbKey('/p/a.jpg', 1000, 500, 'wall'))
  })

  it('differs between levels of the same file', () => {
    expect(thumbKey('/p/a.jpg', 1000, 500, 'wall')).not.toBe(thumbKey('/p/a.jpg', 1000, 500, 'zoom'))
  })

  it('returns a two-level sharded relative path', () => {
    // `a/b/<hash>-<tag>.webp`. The shard comes from the hash, so the same
    // photo always lands in the same leaf directory and lookups stay O(1).
    const key = thumbKey('/p/a.jpg', 1000, 500, 'wall512q78p1')
    const segments = key.split('/')
    expect(segments).toHaveLength(THUMB_SHARD_DEPTH + 1)
    expect(segments[0]).toMatch(/^[0-9a-f]$/)
    expect(segments[1]).toMatch(/^[0-9a-f]$/)
    expect(segments[2]).toMatch(/^[0-9a-f]{16}-wall512q78p1\.webp$/)
  })

  it('derives the shard from the hash, not from the leaf name', () => {
    // Every file's directory prefix must match the head of its own hash, or a
    // lookup could compute one path and write another.
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'IMG_0001.jpg']) {
      const segments = thumbKey(`/p/${name}`, 1, 2, 'wall512q78p1').split('/')
      const hash = segments[2].replace(/-wall512q78p1\.webp$/, '')
      expect(segments.slice(0, THUMB_SHARD_DEPTH).join('')).toBe(hash.slice(0, THUMB_SHARD_DEPTH))
    }
  })

  it('spreads many photos across the shard space', () => {
    // The point of sharding: thousands of files must not land in one directory.
    const keys = Array.from({ length: 2000 }, (_, i) => thumbKey(`/p/${i}.jpg`, 1, 2, 'wall'))
    const leaves = new Set(keys.map((key) => key.split('/').slice(0, 2).join('/')))
    // 16*16 = 256 possible leaves; a decent hash fills most of them.
    expect(leaves.size).toBeGreaterThan(200)
  })

  it('keeps the change-detection behaviour through the shard', () => {
    // A touched file must move to a different key *and* may land in a different
    // directory, which is fine: lookups always recompute from the metadata.
    const base = thumbKey('/p/a.jpg', 1000, 500, 'wall')
    const touched = thumbKey('/p/a.jpg', 2000, 500, 'wall')
    expect(base).not.toBe(touched)
  })
})
