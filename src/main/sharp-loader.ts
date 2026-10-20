import type sharp from 'sharp'

/**
 * Load libvips only when a photo actually needs it.
 *
 * `sharp` is a native module and costs ~40 ms to import on this machine. That
 * used to be part of the main process's module graph, so every launch paid it
 * before the window could even be created — including launches that never open
 * a library. Importing it here, at first use, moves the cost to the first scan
 * or thumbnail, where it overlaps with the renderer coming up.
 *
 * The cache is disabled once, here, before the first `sharp()` call. libvips
 * otherwise keeps decoded images and mapped source files, which on Windows
 * leaves photos locked until the process exits (see `thumbnails.ts`).
 */
type SharpFactory = typeof sharp

let pending: Promise<SharpFactory> | null = null

export function loadSharp(): Promise<SharpFactory> {
  pending ??= import('sharp').then(({ default: sharp }) => {
    sharp.cache(false)
    return sharp
  })
  return pending
}
