import type { ThumbLevel } from './types'
import { LAYOUT_DEFAULTS, MAX_DISPLAY_ASPECT } from './layout'

/**
 * Cached rendition sizes in pixels (long edge).
 *
 * `full` is absent on purpose: it is the original file, never generated and
 * never cached.
 *
 * `wall` is the *floor*, not a fixed size: photos whose aspect ratio makes the
 * wall paint them wider than this get a larger rendition, sized by
 * `wallRenditionEdge`. See that function for why.
 *
 * `zoom` was 1280 and is now 2560. At 1280 the wall jumped straight from a
 * 1280px WebP to the original JPEG, and a camera file is often 6000–8000px —
 * six times the pixels of the rendition it replaced. Rapid zooming therefore
 * decoded a handful of multi-megapixel originals per gesture, which is what
 * made the wall stutter. 2560 covers the magnifications people actually use for
 * a wall (the tiles are 240 world px, so a 2560px rendition holds up to about
 * 10× scale at 1:1 on a 1× display) and pushes the original back to the case
 * where someone is genuinely inspecting one photo.
 */
export const THUMB_SIZES: Record<Exclude<ThumbLevel, 'full'>, number> = {
  wall: 512,
  zoom: 2560
}

/**
 * Long edge a `wall` rendition needs for a photo of this shape.
 *
 * The wall paints each tile at the photo's own aspect ratio, and every layout
 * fixes only one of the two dimensions: `grid` sets the row height, `masonry`
 * the column width, `square` the cell. A single 512px long edge is therefore
 * adequate only near 1:1. The panorama that prompted this (14525x3798) is
 * painted 841x220 in `grid` — 1.6x the bitmap — and 764px wide inside a 200px
 * `square` cell, which is why it looked smeared.
 *
 * Solving the three layouts for the painted long edge, with
 * `a = long / short` clamped the way `computeLayout` clamps it:
 *
 *   landscape: max(targetRowHeight * a, columnWidth)
 *   portrait:  columnWidth * a
 *
 * Only photos past roughly 2:1 (or 1:2) clear the 512px floor, so ordinary
 * photos keep the rendition they have always had. `withoutEnlargement` still
 * caps the result at the source size.
 */
export function wallRenditionEdge(width: number, height: number): number {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return THUMB_SIZES.wall
  const aspect = Math.min(Math.max(w >= h ? w / h : h / w, 1), MAX_DISPLAY_ASPECT)
  const needed =
    w >= h
      ? Math.max(LAYOUT_DEFAULTS.targetRowHeight * aspect, LAYOUT_DEFAULTS.columnWidth)
      : LAYOUT_DEFAULTS.columnWidth * aspect
  // A few pixels over the floor does not warrant a second, larger file: the
  // 512px rendition already covers a tile at that ratio within a few percent.
  return needed > THUMB_SIZES.wall * 1.1 ? Math.ceil(needed) : THUMB_SIZES.wall
}

/**
 * Base tile width in world pixels, used to size the on-screen demand.
 *
 * Kept here rather than passed in so the LOD decision stays a pure function of
 * the zoom level; the value matches `LAYOUT_DEFAULTS` for the common modes.
 */
export const REFERENCE_TILE = 240

/**
 * Choose the best rendition for the current zoom.
 *
 * The previous version capped out at the 1280px level, so anything past
 * `scale ≈ 2.4` was upscaled and visibly blurry. Serving the original beyond
 * that point costs one decode but keeps the wall sharp at any magnification.
 */
export function pickThumbLevel(worldPixels: number, scale: number, devicePixelRatio = 1): ThumbLevel {
  const needed = Math.abs(worldPixels * scale * devicePixelRatio)
  if (!Number.isFinite(needed)) return 'wall'
  if (needed > THUMB_SIZES.zoom * 0.9) return 'full'
  if (needed > THUMB_SIZES.wall * 0.9) return 'zoom'
  return 'wall'
}

/**
 * Whether a `zoom` rendition of this photo would hold more detail than `wall`.
 *
 * `buildThumbnail` resizes with `withoutEnlargement`, so a 300x200 JPEG yields a
 * 300x200 `wall` file *and* a 300x200 `zoom` file: the same pixels, encoded
 * twice, differing only in WebP quality. Measured on a 300x200 source: 200 B for
 * `wall`, 192 B for `zoom` — two files, no extra detail. The second encode is
 * pure cost, and it happens for every small image in the library.
 *
 * The comparison is against `wallRenditionEdge`, not the 512px floor, because a
 * panorama's `wall` file is already larger than 512: a 600x200 source gets a
 * 600x200 wall rendition, so a zoom file of the same size would be duplication.
 *
 * Deciding from the source dimensions rather than the target ones is what makes
 * this possible: the scan has already parsed `width`/`height` for every photo, so
 * no extra file read is needed.
 *
 * Non-positive or unknown dimensions return `true`, the safe answer: generating a
 * rendition that may be redundant costs disk, while skipping one that was needed
 * would leave the tile permanently soft.
 */
export function zoomTierAddsDetail(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return true
  const longEdge = Math.max(width, height)
  return longEdge > wallRenditionEdge(width, height)
}

/**
 * Size bucket for display-sized renditions.
 *
 * The viewer paints one photo at a known device-pixel size, and a rendition that
 * matches it is markedly sharper than a larger one the browser has to shrink
 * again. Measured on an 8064x6048 original shown at 1840 device px:
 *
 *   zoom tier (2560) shrunk by the browser     21.35 gradient energy
 *   sized to 1840 by sharp                     24.33
 *   ideal Lanczos reference                    24.64
 *
 * Rounding to 256 px keeps the cache from growing one file per window size while
 * staying within ~7% of the exact size.
 */
export const VIEWER_EDGE_BUCKET = 256

/**
 * The long edge to generate for a photo that will be painted at `devicePx`.
 *
 * Returns `null` when the answer is not a sized rendition: anything at or below
 * the `wall` size is already covered by that tier, and anything above the `zoom`
 * size must come from the original instead, because generating a bigger
 * intermediate would only add a second downscale.
 */
export function viewerEdge(devicePx: number): number | null {
  if (!Number.isFinite(devicePx) || devicePx <= 0) return null
  if (devicePx > THUMB_SIZES.zoom) return null
  const bucketed = Math.ceil(devicePx / VIEWER_EDGE_BUCKET) * VIEWER_EDGE_BUCKET
  const clamped = Math.min(THUMB_SIZES.zoom, bucketed)
  // Below the wall tier there is nothing to gain: the `wall` file already holds
  // at least this many pixels and is shared with the photo wall.
  return clamped < THUMB_SIZES.wall ? null : clamped
}

/**
 * How many leading hash characters become directory names.
 *
 * Two levels of one character each (`ab/cd/…`), which is what Lightroom does:
 * 256 leaf directories hold an even spread of filenames, so no single directory
 * grows to tens of thousands of entries.
 *
 * This matters more here than for a single library: one cache serves *every*
 * folder the user has ever opened, and each photo contributes up to two
 * renditions, so the file count grows faster than the photo count. A flat
 * directory is fine at 3 000 entries and unpleasant at 100 000 — enumeration,
 * deletion and Explorer itself all degrade.
 */
export const THUMB_SHARD_DEPTH = 2

/** Characters of the hash used for directory names, per level. */
export const THUMB_SHARD_WIDTH = 1

/**
 * Cache key: a sharded relative path.
 *
 * Returns `a/b/<hash>-<level>.webp` — a POSIX-style relative path, not a bare
 * filename, because callers must create the directories and serve the file over
 * `pic://thumb` with the same shape.
 *
 * Stable across runs: the shard comes from the hash, so the same photo always
 * lands in the same leaf directory.
 *
 * `level` is a plain string rather than the `ThumbLevel` union because the
 * viewer requests display-sized renditions tagged `viewer1856`; the tag only
 * has to be unique per size, and widening it here keeps one cache-key rule
 * instead of two.
 */
export function thumbKey(
  path: string,
  mtimeMs: number,
  sizeBytes: number,
  level: string
): string {
  const hash = hash64(`${path}|${mtimeMs}|${sizeBytes}|${level}`)
  const shards: string[] = []
  for (let i = 0; i < THUMB_SHARD_DEPTH; i += 1) {
    shards.push(hash.slice(i * THUMB_SHARD_WIDTH, (i + 1) * THUMB_SHARD_WIDTH))
  }
  return [...shards, `${hash}-${level}.webp`].join('/')
}

/**
 * FNV-1a 64-bit, expressed with 32-bit halves so it works without BigInt in
 * every JS engine and stays identical between Node and the renderer tests.
 */
export function hash64(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= code ^ 0x9e37
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
