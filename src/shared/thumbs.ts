import type { ThumbLevel } from './types'

export const THUMB_SIZES: Record<ThumbLevel, number> = {
  wall: 512,
  zoom: 1280
}

/**
 * Choose the smallest cached rendition that still has enough pixels for the
 * on-screen size. `worldPixels` is the item's width in world units, so the
 * device pixel ratio has to be folded in before comparing.
 *
 * Zoomed-in tiles use the sharper level; everything else stays on the wall
 * level, which is what keeps the on-disk cache small.
 */
export function pickThumbLevel(worldPixels: number, scale: number, devicePixelRatio = 1): ThumbLevel {
  const needed = Math.abs(worldPixels * scale * devicePixelRatio)
  if (!Number.isFinite(needed)) return 'wall'
  return needed > THUMB_SIZES.wall * 0.9 ? 'zoom' : 'wall'
}

/** Cache directory key for a photo rendition. Stable across runs and machines. */
export function thumbKey(path: string, mtimeMs: number, sizeBytes: number, level: ThumbLevel): string {
  return `${hash64(`${path}|${mtimeMs}|${sizeBytes}|${level}`)}-${level}.webp`
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
