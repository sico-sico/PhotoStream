import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isCurrentRenditionTag } from '../shared/thumbs'
import type { CacheStats } from '../shared/types'

/**
 * Thumbnail cache housekeeping.
 *
 * Two jobs, both driven by the fact that a cache filename is self-describing:
 *
 * 1. **Orphans.** A file whose name this build could not have written is from an
 *    older algorithm, an older quality setting or an older pipeline revision.
 *    Nothing will ever read it again, so it is deleted instead of lingering
 *    forever. This is what makes changing the encoder safe: the new build simply
 *    asks for a different name.
 *
 * 2. **Budget.** The cache serves every folder the user has ever opened, and the
 *    viewer writes a `viewer<edge>` file per rounded display size, so growth is
 *    unbounded by construction. When the user sets a limit, the least recently
 *    written files are evicted until the cache is back under it.
 *
 * The orphan rule is deliberately *positive*: only files this build recognises
 * as its own and rejects are removed. Anything unparseable is kept and reported
 * as `unknown`, because "delete everything I do not understand" is how a cleaner
 * eventually eats something it should not have.
 */

/**
 * Files younger than this are never deleted.
 *
 * It covers the encode currently being renamed into place and the ones the
 * renderer is reading over `pic://` right now — Windows refuses to delete those
 * anyway, but not touching them at all avoids a pointless failure and a second
 * pass. Ten minutes is far longer than any single encode.
 */
export const PROTECTED_AGE_MS = 10 * 60 * 1000

/** A temporary file is only collected once it is clearly not mid-rename. */
export const TEMP_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Evict down to this fraction of the budget.
 *
 * Stopping exactly at the limit would put the cache one file away from the next
 * sweep, so every subsequent encode would trigger another walk.
 */
export const TRIM_TO_FRACTION = 0.9

/** Minimum gap between budget-triggered sweeps. */
export const SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000

/** Depth guard while walking: the real layout is `thumbs/a/b/*.webp`. */
const MAX_WALK_DEPTH = 6

/** `<16 hex>-<tag>.webp`, the shape `thumbKey` produces. */
const RENDITION_FILE = /^[0-9a-f]{16}-(.+)\.webp$/

export type CacheFileKind = 'current' | 'orphan' | 'temp' | 'unknown'

/**
 * What a cache file is, judged from its name alone.
 *
 * Names are the cache's only state, so this is the whole "is it still valid"
 * decision. `unknown` means the name does not follow this app's convention at
 * all; those files are never deleted by the sweeper.
 */
export function classifyCacheFileName(name: string): CacheFileKind {
  if (name.endsWith('.tmp')) return 'temp'
  const match = RENDITION_FILE.exec(name)
  if (!match) return 'unknown'
  return isCurrentRenditionTag(match[1]) ? 'current' : 'orphan'
}

export interface CacheSweepResult {
  /** Bytes still on disk after the sweep, including files kept as `unknown`. */
  bytes: number
  /** Rendition files still on disk after the sweep. */
  files: number
  removedFiles: number
  removedBytes: number
  /** Empty shard directories that were removed. */
  removedDirs: number
}

export interface CacheSweepOptions {
  /** Bytes allowed on disk. `0` (the default) disables eviction. */
  budgetBytes?: number
  /** Injected clock, so tests can age files without waiting. */
  now?: number
}

interface CacheEntry {
  path: string
  size: number
  mtimeMs: number
}

/**
 * Walk the cache once: delete orphans and stale temporaries, then evict down to
 * the budget if one is set.
 *
 * One walk does both jobs because the second needs the sizes the first already
 * stats.
 */
export async function sweepThumbCache(
  cacheDir: string,
  options: CacheSweepOptions = {}
): Promise<CacheSweepResult> {
  const now = options.now ?? Date.now()
  const budgetBytes = Math.max(0, options.budgetBytes ?? 0)
  const result: CacheSweepResult = {
    bytes: 0,
    files: 0,
    removedFiles: 0,
    removedBytes: 0,
    removedDirs: 0
  }

  const survivors: CacheEntry[] = []
  const directories: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A directory that vanished or is unreadable is not worth failing over.
      return
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        directories.push(path)
        if (depth < MAX_WALK_DEPTH) await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }

      const kind = classifyCacheFileName(entry.name)
      const minAge = kind === 'temp' ? TEMP_MIN_AGE_MS : PROTECTED_AGE_MS
      if ((kind === 'orphan' || kind === 'temp') && now - info.mtimeMs > minAge) {
        if (await removeFile(path)) {
          result.removedFiles += 1
          result.removedBytes += info.size
          continue
        }
      }

      result.bytes += info.size
      result.files += 1
      survivors.push({ path, size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  await walk(cacheDir, 0)

  if (budgetBytes > 0 && result.bytes > budgetBytes) {
    const target = Math.floor(budgetBytes * TRIM_TO_FRACTION)
    // Oldest first: creation time is the only signal stored on disk, and
    // Windows keeps last-access times disabled by default so a true LRU would
    // need a write per thumbnail.
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of survivors) {
      if (result.bytes <= target) break
      // Never evict what this session may still be writing or serving.
      if (now - entry.mtimeMs <= PROTECTED_AGE_MS) continue
      if (!(await removeFile(entry.path))) continue
      result.bytes -= entry.size
      result.files -= 1
      result.removedFiles += 1
      result.removedBytes += entry.size
    }
  }

  // Deepest first, so a shard leaf is removed before its parent is considered.
  directories.sort((a, b) => b.length - a.length)
  for (const dir of directories) {
    try {
      if ((await readdir(dir)).length === 0) {
        await rmdir(dir)
        result.removedDirs += 1
      }
    } catch {
      // Not empty, in use, or already gone.
    }
  }

  return result
}

async function removeFile(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true })
    return true
  } catch {
    // Windows returns EBUSY/EPERM for a file the app is still reading. It is
    // protected work, not a problem: the next sweep will pick it up.
    return false
  }
}

/**
 * The cache as the rest of the main process sees it.
 *
 * Holds an approximate running total so the settings menu can answer "how much
 * disk is this using" without a directory walk every time it opens, and decides
 * when a sweep is due.
 */
export class ThumbCache {
  private current: CacheStats = { bytes: 0, files: 0, ready: false }
  private budgetBytes: number
  private sweeping: Promise<CacheSweepResult> | null = null
  private lastSweepAt = 0
  /**
   * Bytes encoded while the sweep was walking.
   *
   * The walk stats files as it goes, so anything written after it passed that
   * directory would otherwise be missing from the total. They are added on top;
   * a file the walk did see can be counted twice, which only ever errs towards
   * evicting a little early.
   */
  private writtenDuringSweep = 0

  constructor(
    readonly dir: string,
    budgetBytes = 0
  ) {
    this.budgetBytes = Math.max(0, Math.floor(budgetBytes))
  }

  /** Last known usage. `ready` is false until the first sweep completes. */
  stats(): CacheStats {
    return { ...this.current }
  }

  /** Change the limit; a lower one takes effect immediately. */
  setBudget(budgetBytes: number): void {
    this.budgetBytes = Math.max(0, Math.floor(budgetBytes))
    if (this.budgetBytes > 0 && this.current.ready && this.current.bytes > this.budgetBytes) {
      // Forced: the user just asked for less disk, so waiting out the throttle
      // would leave the cache over the limit they set.
      void this.sweep({ force: true })
    }
  }

  /** Record a rendition this process just encoded. */
  noteWritten(bytes: number): void {
    if (!(bytes > 0)) return
    this.current.bytes += bytes
    if (this.sweeping) this.writtenDuringSweep += bytes
    if (this.budgetBytes > 0 && this.current.bytes > this.budgetBytes) void this.sweep()
  }

  /**
   * Sweep once, or join the sweep already running.
   *
   * `force` bypasses the throttle: the startup pass must always run (it is what
   * computes the size the settings menu shows), and a budget the user just
   * lowered should take effect now rather than ten minutes later.
   *
   * Returns `null` when the call was throttled.
   */
  async sweep(options: { force?: boolean } = {}): Promise<CacheSweepResult | null> {
    if (this.sweeping) return this.sweeping

    const now = Date.now()
    if (!options.force && this.lastSweepAt > 0 && now - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) {
      return null
    }

    this.lastSweepAt = now
    this.writtenDuringSweep = 0

    const run = (async (): Promise<CacheSweepResult> => {
      const result = await sweepThumbCache(this.dir, { budgetBytes: this.budgetBytes })
      this.current = {
        bytes: result.bytes + this.writtenDuringSweep,
        files: result.files,
        ready: true
      }
      this.writtenDuringSweep = 0
      return result
    })()

    this.sweeping = run
    try {
      return await run
    } finally {
      this.sweeping = null
    }
  }
}
