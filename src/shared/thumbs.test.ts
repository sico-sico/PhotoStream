import { describe, expect, it } from 'vitest'
import { THUMB_SHARD_DEPTH, THUMB_SIZES, hash64, pickThumbLevel, thumbKey } from './thumbs'

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
  it('encodes the level in the file name', () => {
    expect(thumbKey('/p/a.jpg', 1, 2, 'wall')).toMatch(/-wall\.webp$/)
    expect(thumbKey('/p/a.jpg', 1, 2, 'zoom')).toMatch(/-zoom\.webp$/)
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
    // `a/b/<hash>-<level>.webp`. The shard comes from the hash, so the same
    // photo always lands in the same leaf directory and lookups stay O(1).
    const key = thumbKey('/p/a.jpg', 1000, 500, 'wall')
    const segments = key.split('/')
    expect(segments).toHaveLength(THUMB_SHARD_DEPTH + 1)
    expect(segments[0]).toMatch(/^[0-9a-f]$/)
    expect(segments[1]).toMatch(/^[0-9a-f]$/)
    expect(segments[2]).toMatch(/^[0-9a-f]{16}-wall\.webp$/)
  })

  it('derives the shard from the hash, not from the leaf name', () => {
    // Every file's directory prefix must match the head of its own hash, or a
    // lookup could compute one path and write another.
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'IMG_0001.jpg']) {
      const segments = thumbKey(`/p/${name}`, 1, 2, 'wall').split('/')
      const hash = segments[2].replace(/-wall\.webp$/, '')
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
