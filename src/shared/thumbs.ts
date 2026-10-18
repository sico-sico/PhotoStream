import type { ThumbLevel } from './types'

/**
 * Cached rendition sizes in pixels (long edge).
 *
 * `full` is absent on purpose: it is the original file, never generated and
 * never cached.
 */
export const THUMB_SIZES: Record<Exclude<ThumbLevel, 'full'>, number> = {
  wall: 512,
  zoom: 1280
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
 */
export function thumbKey(
  path: string,
  mtimeMs: number,
  sizeBytes: number,
  level: Exclude<ThumbLevel, 'full'>
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
