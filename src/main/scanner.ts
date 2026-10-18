import { readdir, stat } from 'node:fs/promises'
import { join, basename, extname, resolve } from 'node:path'
import type { Photo, ScanResult } from '../shared/types'
import { sortPhotos } from '../shared/photoStore'
import { readImageMetadata } from './metadata'

/**
 * Only JPEG for now. HEIC needs an external decoder and RAW needs a huge
 * dependency; both are deliberately out of scope.
 */
export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg'])

export function isSupportedImage(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Stable id: a cheap hash of the absolute path, so re-scans keep tile identity. */
export function photoId(path: string): string {
  return path.toLowerCase()
}

export interface ScanOptions {
  /** Called after each photo so the UI can render tiles progressively. */
  onPhoto?: (photo: Photo, index: number, total: number) => void
  /** Number of files read in parallel. 8 saturates the disk without thrashing. */
  concurrency?: number
  signal?: AbortSignal
}

/**
 * List candidate files in a directory, sorted by name.
 * Sorting here means the progressive render order matches the final order.
 */
export async function listImageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && isSupportedImage(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

async function toPhoto(dir: string, name: string): Promise<Photo | null> {
  const path = join(dir, name)
  try {
    const info = await stat(path)
    const meta = await readImageMetadata(path)
    return {
      id: photoId(path),
      path,
      name: basename(name),
      width: meta.width,
      height: meta.height,
      takenAt: meta.takenAt,
      dateSource: meta.takenAt ? 'exif' : 'none',
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size
    }
  } catch {
    // Deleted mid-scan, permission denied, unreadable: skip quietly.
    return null
  }
}

/**
 * Scan a directory.
 *
 * Results are ordered by capture date (oldest first) then by name, with
 * undated photos last. A stable sort keeps the wall deterministic between runs.
 */
export async function scanDirectory(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now()
  const absolute = resolve(dir)
  const names = await listImageFiles(absolute)
  const concurrency = Math.max(1, options.concurrency ?? 8)
  const photos: Photo[] = []
  let skipped = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= names.length) return
      if (options.signal?.aborted) return

      const photo = await toPhoto(absolute, names[index])
      if (!photo) {
        skipped += 1
        continue
      }
      photos.push(photo)
      options.onPhoto?.(photo, photos.length, names.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker))

  return {
    dir: absolute,
    // One sorting rule lives in `photoStore` so the watcher's incremental
    // updates cannot drift from the scan order.
    photos: sortPhotos(photos),
    skipped,
    durationMs: Date.now() - started
  }
}
