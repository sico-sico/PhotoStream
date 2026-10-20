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
 * Which family a cached rendition belongs to.
 *
 * Not the same as `ThumbLevel`: the viewer asks for a `zoom`-shaped request but
 * gets a display-sized `viewer` file, which is its own family because it has its
 * own quality and its own set of legal edges.
 */
export type RenditionKind = 'wall' | 'zoom' | 'viewer'

/**
 * WebP quality per family.
 *
 * Part of the cache key rather than a number buried in the encoder: raising it
 * has to invalidate the files written at the old value, or the improvement
 * would never reach a user who had already browsed that folder.
 *
 * `viewer` is the highest of the three because it is the tier a single photo is
 * read at, and unlike the wall tiers it is not downscaled again by the browser,
 * so any artefact it carries stays visible.
 */
export const THUMB_QUALITY = { wall: 78, zoom: 82, viewer: 85 } as const

/**
 * Revision of everything else in the encoding pipeline.
 *
 * `THUMB_QUALITY` covers the encoder's quality knob and the edge covers
 * geometry, but neither changes when the *order* of operations changes
 * (rotate → resize → flatten → WebP) or when the output format does. Bump this
 * by hand for those; the cache sweeper treats every older revision as an orphan,
 * so the next browse re-encodes with the new pipeline.
 */
export const THUMB_PIPELINE_REVISION = 1

/**
 * Widest `wall` edge a cached file may carry and still be considered current.
 *
 * Deliberately wider than `wallRenditionEdge` can return today (512 or
 * 564..1300). The sweeper only has to reject renditions that are provably from
 * an older build, and a bound computed too tightly there would delete files that
 * are still usable. It is still finite, so changing the layout constants (say a
 * 300px row height) does retire the old geometry instead of keeping it forever.
 */
export const WALL_EDGE_ACCEPTED_MAX = 2048

/**
 * Cache tag for one rendition: `<kind><edge>q<quality>p<revision>`.
 *
 * Self-describing on purpose. A filename is the only state the cache keeps, so
 * everything that determines the bytes has to be in the name; that is what makes
 * the sweeper possible without a manifest that could fall out of sync.
 */
export function renditionCacheTag(kind: RenditionKind, edge: number, quality: number): string {
  return `${kind}${edge}q${quality}p${THUMB_PIPELINE_REVISION}`
}

const RENDITION_TAG_PATTERN = /^(wall|zoom|viewer)(\d+)q(\d+)p(\d+)$/

export interface ParsedRenditionTag {
  kind: RenditionKind
  edge: number
  quality: number
  revision: number
}

/** Parse a cache tag, or `null` when it is not one of ours. */
export function parseRenditionTag(tag: string): ParsedRenditionTag | null {
  const match = RENDITION_TAG_PATTERN.exec(tag)
  if (!match) return null
  const edge = Number(match[2])
  const quality = Number(match[3])
  const revision = Number(match[4])
  if (!Number.isInteger(edge) || edge <= 0) return null
  if (!Number.isInteger(quality) || !Number.isInteger(revision)) return null
  return { kind: match[1] as RenditionKind, edge, quality, revision }
}

/**
 * Whether this build could have written the tag, and could still read it.
 *
 * Used only by the cache sweeper, so it answers one question: is this file worth
 * keeping? Unknown shapes are handled by the caller, which keeps them; this
 * function says `false` for anything it does not recognise.
 */
export function isCurrentRenditionTag(tag: string): boolean {
  const parsed = parseRenditionTag(tag)
  if (!parsed) return false
  if (parsed.revision !== THUMB_PIPELINE_REVISION) return false

  switch (parsed.kind) {
    case 'wall':
      return (
        parsed.quality === THUMB_QUALITY.wall &&
        parsed.edge >= THUMB_SIZES.wall &&
        parsed.edge <= WALL_EDGE_ACCEPTED_MAX
      )
    case 'zoom':
      return parsed.quality === THUMB_QUALITY.zoom && parsed.edge === THUMB_SIZES.zoom
    case 'viewer':
      return (
        parsed.quality === THUMB_QUALITY.viewer &&
        parsed.edge >= THUMB_SIZES.wall &&
        parsed.edge <= THUMB_SIZES.zoom &&
        parsed.edge % VIEWER_EDGE_BUCKET === 0
      )
  }
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
 * Returns `a/b/<hash>-<tag>.webp` — a POSIX-style relative path, not a bare
 * filename, because callers must create the directories and serve the file over
 * `pic://thumb` with the same shape.
 *
 * Stable across runs: the shard comes from the hash, so the same photo always
 * lands in the same leaf directory.
 *
 * `level` is a plain string rather than the `ThumbLevel` union because the tag
 * now encodes the rendition itself (`wall842q78p1`, `viewer1792q85p1`), and the
 * key has to stay one rule instead of one per family.
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
