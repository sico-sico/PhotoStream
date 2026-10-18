import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import type { Photo, ScanResult } from '../shared/types'
import { resolvePhotoDate } from '../shared/date'
import { sortPhotos } from '../shared/photoStore'
import { readImageMetadata } from './metadata'
import type { MetadataCache } from './metadata-cache'

/**
 * Formats the wall accepts.
 *
 * PNG is included because it needs no extra decoder — `sharp` handles it
 * natively and Chromium can display the original directly, so the whole
 * pipeline works unchanged. It costs more than JPEG (a lossless 4000x3000 file
 * is ~12x larger and decodes ~3x slower) but nothing structural.
 *
 * HEIC is still out of scope: the bundled libvips has no HEVC decoder
 * (`heif: Support for this compression format has not been built in`), and
 * neither Chromium nor the prebuilt `sharp` can read one. RAW needs a huge
 * dependency. Both would be a change of architecture rather than of a list.
 */
export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])

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
  /**
   * Cache of previously parsed metadata.
   *
   * Reading EXIF costs a 512 KB prefix per photo, measured at 1178 ms for 3226
   * photos. A cached row answers in microseconds, so a re-opened folder skips
   * the file reads entirely.
   */
  cache?: MetadataCache
  /**
   * Include JPEGs in subdirectories, recursively. Off by default.
   *
   * Off because a photo library is often browsed from a parent folder (say
   * `Pictures/`) where the interesting set is the whole tree, but equally often
   * a folder holds one shoot and its `_rejected/` subfolder would only add
   * noise. The setting lives in the gear menu because the right answer depends
   * on how the user organises their disk, not on the folder itself.
   */
  recursive?: boolean
}

/**
 * Recursion guard.
 *
 * A junction or symlink loop on Windows would otherwise make the walk descend
 * forever. The depth cap is the backstop for cycles the visited set cannot see
 * (for example, two junctions pointing at each other through a path that
 * normalises differently).
 */
export const MAX_SCAN_DEPTH = 24

/** Directory names skipped during a recursive scan. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information'])

/**
 * List candidate files in a directory.
 *
 * Returns *relative* paths (POSIX-style separators) so a recursive scan can tell
 * `2024/a.jpg` from `2025/a.jpg`. Sorting here means the progressive render
 * order matches the final order.
 */
export async function listImageFiles(dir: string, recursive = false): Promise<string[]> {
  if (!recursive) {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && isSupportedImage(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }

  const found: string[] = []
  const visited = new Set<string>()

  const walk = async (absolute: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return

    // Compare real paths so a junction loop is caught rather than walked twice.
    let key: string
    try {
      key = (await realpath(absolute)).toLowerCase()
    } catch {
      return
    }
    if (visited.has(key)) return
    visited.add(key)

    // Explicitly typed: without `encoding: 'utf8'` Node's overloads widen
    // `Dirent.name` to `string | Buffer`, which makes every string operation on
    // it a type error.
    let entries: Dirent[]
    try {
      entries = await readdir(absolute, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      // Unreadable directory (permissions, a vanished drive): skip it and keep
      // the rest of the scan useful.
      return
    }

    const subdirectories: string[] = []
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isFile() && isSupportedImage(entry.name)) {
        found.push(relative)
        continue
      }
      if (!entry.isDirectory()) continue
      // Hidden and well-known noise directories are skipped: they never hold
      // user photos, and walking them can be very slow.
      if (entry.name.startsWith('.')) continue
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      subdirectories.push(entry.name)
    }

    for (const name of subdirectories) {
      await walk(join(absolute, name), prefix ? `${prefix}/${name}` : name, depth + 1)
    }
  }

  await walk(dir, '', 0)
  return found.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/**
 * Build one photo from a *relative* name within `dir`.
 *
 * `name` is the relative path, so a recursive scan distinguishes `2024/a.jpg`
 * from `2025/a.jpg`. `basename` is deliberately not applied: two same-named
 * photos in different subfolders are different photos, and showing both as
 * `a.jpg` would make the filename filter match the wrong one.
 */
async function toPhoto(dir: string, name: string, cache?: MetadataCache): Promise<Photo | null> {
  // Normalise the separator so a nested name works on Windows and in tests.
  const path = join(dir, ...name.split('/'))
  try {
    const info = await stat(path)
    // `stat` is needed regardless: it supplies the mtime and size that decide
    // whether a cached row is still valid.
    const cached = cache?.lookup(path, info.mtimeMs, info.size)
    if (cached) {
      // The cache stores only what the file itself said. The mtime fallback is
      // applied here rather than cached, so changing the policy never leaves a
      // stale derived date behind.
      const date = resolvePhotoDate(cached.takenAt, info.mtimeMs)
      return {
        id: photoId(path),
        path,
        name,
        width: cached.width,
        height: cached.height,
        takenAt: date.takenAt,
        dateSource: date.dateSource,
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size
      }
    }

    const meta = await readImageMetadata(path)
    cache?.store(path, info.mtimeMs, info.size, meta)
    const date = resolvePhotoDate(meta.takenAt, info.mtimeMs)
    return {
      id: photoId(path),
      path,
      name,
      width: meta.width,
      height: meta.height,
      takenAt: date.takenAt,
      dateSource: date.dateSource,
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
  const names = await listImageFiles(absolute, options.recursive === true)
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

      const photo = await toPhoto(absolute, names[index], options.cache)
      if (!photo) {
        skipped += 1
        continue
      }
      photos.push(photo)
      options.onPhoto?.(photo, photos.length, names.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker))

  // Drop rows for files that no longer exist in *this* folder, so the database
  // does not grow with every re-export. Scoped to the folder: the cache is
  // shared by every library the user has opened, and wiping the others would
  // defeat the point of remembering them.
  options.cache?.retain(absolute, photos.map((photo) => photo.path))

  return {
    dir: absolute,
    // One sorting rule lives in `photoStore` so the watcher's incremental
    // updates cannot drift from the scan order.
    photos: sortPhotos(photos),
    skipped,
    durationMs: Date.now() - started
  }
}
