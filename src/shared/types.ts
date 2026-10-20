/**
 * Where a photo's date came from.
 *
 * `exif` is authoritative: the camera recorded when the shutter fired.
 * `mtime` is the fallback — the file's modification time — used for PNGs,
 * screenshots and anything else exported without EXIF. It is an approximation
 * and the interface says so, but it is far better than filing a photo under "no
 * date": every photo then has a place in the timeline instead of a separate
 * undated pile at the end.
 *
 * `none` survives only for a file whose modification time could not be read,
 * which in practice means the file vanished mid-scan.
 */
export type DateSource = 'exif' | 'mtime' | 'none'

export interface Photo {
  /** Stable id derived from the absolute file path. */
  id: string
  path: string
  /** File name including extension. */
  name: string
  width: number
  height: number
  /** Local capture date as `YYYY-MM-DD`, or empty string when unknown. */
  takenAt: string
  dateSource: DateSource
  mtimeMs: number
  sizeBytes: number
}

export interface ScanResult {
  dir: string
  photos: Photo[]
  /** Files that were skipped because they could not be read. */
  skipped: number
  durationMs: number
}

/**
 * A folder's previous contents, from the metadata cache.
 *
 * Sent once per open, before the scan finishes: it is the wall as it was last
 * time, so a known folder can be painted immediately instead of waiting for
 * every file to be `stat`ed. `dir` is the string the caller asked for (not the
 * resolved path), so the renderer can discard a snapshot that belongs to a
 * folder it has already left.
 *
 * Deliberately a *snapshot*, not progress: the wall's layout is derived from
 * the whole photo set, so growing it incrementally re-lays out and re-anchors
 * the view on every batch (see docs/architecture.md).
 */
export interface ScanSeed {
  dir: string
  photos: Photo[]
}

/**
 * Result of opening a path the user handed to the app.
 *
 * `photo` is the absolute path to focus, or `''` when a whole folder was opened.
 * It is deliberately a path rather than an id: the renderer looks up the photo
 * by id, and building that id here would duplicate the hashing rule that lives
 * in the scanner.
 */
export interface OpenDroppedResult extends ScanResult {
  photo: string
}

export type LayoutMode = 'grid' | 'masonry' | 'square'

/**
 * Order of the photo wall.
 *
 * `taken-desc` is the default: a photo wall is a stream, and the newest photos
 * are the ones a user is looking for. `taken-asc` keeps the historical order
 * available for browsing a trip from its beginning.
 */
export type SortMode = 'taken-desc' | 'taken-asc' | 'name-asc' | 'name-desc'

export const DEFAULT_SORT: SortMode = 'taken-desc'

export interface Filters {
  /** Inclusive lower bound, `YYYY-MM-DD`, empty means open. */
  from: string
  /** Inclusive upper bound, `YYYY-MM-DD`, empty means open. */
  to: string
  /** Case-insensitive substring match against the file name. */
  text: string
}

export const EMPTY_FILTERS: Filters = { from: '', to: '', text: '' }

/**
 * The bounds of the ring-size preference.
 *
 * Chosen from measurement rather than taste. The scatter cannot place more than
 * about 63 cards in a 2560x1440 window before the overlap budget is exhausted, so
 * 90 is already more candidates than the screen can take; going lower is the
 * useful direction, because a smaller pool leaves bigger gaps and a calmer
 * screen. 30 is the floor: below that the ring stops reading as a cloud around
 * the centre photo.
 */
export const RING_SIZE_RANGE = { min: 30, max: 90 } as const

/** Enough candidates to fill a large window, without being a memory concern. */
export const DEFAULT_RING_SIZE = 70

/** Clamp an arbitrary number into the supported range, rounding to a whole count. */
export function clampRingSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RING_SIZE
  return Math.min(RING_SIZE_RANGE.max, Math.max(RING_SIZE_RANGE.min, Math.round(value)))
}

/**
 * Thumbnail-cache limit, in megabytes. `0` means no limit.
 *
 * Zero is the default because any number would be a guess about someone else's
 * disk: a user who browses two folders a year and one who browses a decade of
 * shoots need wildly different values. What is *not* left to the user is orphan
 * collection — that runs regardless, because stale files are a correctness
 * problem rather than a space policy.
 */
export const CACHE_BUDGET_UNLIMITED = 0

/** Values offered in the settings menu. Hand-edited files may hold others. */
export const CACHE_BUDGET_PRESETS = [CACHE_BUDGET_UNLIMITED, 1024, 2048, 4096, 8192] as const

/**
 * Ceiling for a hand-edited value.
 *
 * Generous enough that nobody legitimate hits it, finite so a typo cannot ask
 * the sweeper to compare against `Number.MAX_SAFE_INTEGER`.
 */
export const CACHE_BUDGET_MAX_MB = 1024 * 1024

/** Clamp an arbitrary value into a usable megabyte count. */
export function clampCacheBudgetMb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return CACHE_BUDGET_UNLIMITED
  return Math.min(CACHE_BUDGET_MAX_MB, Math.round(value))
}

export interface Settings {
  lastDir: string
  layout: LayoutMode
  /** Wall ordering. Legacy files omit it; `sanitizeSettings` fills the default. */
  sort: SortMode
  filters: Filters
  /**
   * BCP-47 locale tag chosen by the user, or `''` to follow the system locale.
   * Stored as a preference rather than a resolved tag so that a user who picks
   * "follow system" keeps tracking it after an OS language change.
   */
  locale: string
  /**
   * Recently opened folders, most recent first.
   *
   * Persisted here rather than in a separate file because it is a preference in
   * the same sense as the layout: losing it should be harmless, and it has no
   * meaning outside the settings that produced it.
   */
  history: string[]
  /**
   * Whether to include photos in subfolders, recursively.
   *
   * Off by default. A folder is usually one shoot, and pulling in every
   * `_rejected/` and `.cache/` subfolder would bury the photos the user meant.
   * Users who organise by year (`Pictures/2024/...`) can turn it on.
   */
  recursive: boolean
  /**
   * Whether the EXIF panel is shown in the single-photo viewer.
   *
   * A remembered choice rather than a per-photo one: someone who wants the
   * details wants them for every photo they step through, and having to press
   * `I` again after each arrow key is the behaviour that makes the panel feel
   * broken. Persisted so it also survives a restart.
   */
  viewerInfo: boolean
  /**
   * How many photos the random show arranges around the centre one.
   *
   * The scatter drops whatever does not fit, so this is an upper bound rather
   * than a promise: at 2560x1440 about 63 of 90 actually find a slot, and a
   * smaller ring is what a screen that feels crowded needs. Bounded to
   * `RING_SIZE_RANGE` so a hand-edited file cannot ask for a thousand cards.
   */
  ringSize: number
  /**
   * Thumbnail-cache limit in megabytes; `0` means unlimited.
   *
   * The cache serves every folder ever opened, so without a limit it only ever
   * grows. A limit turns that into "keep the most recent N megabytes", evicting
   * the oldest renditions; they are cheap to rebuild.
   */
  cacheBudgetMb: number
}

export const DEFAULT_SETTINGS: Settings = {
  lastDir: '',
  layout: 'grid',
  sort: DEFAULT_SORT,
  filters: EMPTY_FILTERS,
  locale: '',
  history: [],
  recursive: false,
  viewerInfo: false,
  ringSize: DEFAULT_RING_SIZE,
  cacheBudgetMb: CACHE_BUDGET_UNLIMITED
}

/**
 * Disk usage of the thumbnail cache.
 *
 * `ready` is false until the first background sweep has finished walking the
 * directory, which is when the numbers become meaningful rather than zero.
 */
export interface CacheStats {
  bytes: number
  files: number
  ready: boolean
}

/**
 * Which rendition of a photo to show.
 *
 * `wall` and `zoom` are cached WebP thumbnails; `full` streams the original
 * file, which is the only way to stay sharp at high magnification.
 */
export type ThumbLevel = 'wall' | 'zoom' | 'full'

/**
 * How urgently a thumbnail is needed.
 *
 * `interactive` is for tiles that are on screen right now; `background` is for
 * speculative work such as scroll prefetching. The main process drains the
 * interactive lane first, so a prefetch can never delay something the user is
 * looking at.
 */
export type ThumbPriority = 'interactive' | 'background'

export interface ThumbRequest {
  path: string
  mtimeMs: number
  sizeBytes: number
  level: ThumbLevel
}

export interface ThumbProgress {
  done: number
  total: number
}

export interface AppInfo {
  version: string
  dataDir: string
  thumbCacheDir: string
  /**
   * Locale tags the OS reports, most preferred first. Used only to pick a
   * sensible initial language; the user's own choice always wins.
   */
  systemLocales: string[]
  /**
   * Runtime versions, shown in the About dialog.
   *
   * Reported rather than inferred so a bug report can name the exact Chromium
   * build that rendered a layout, which matters when tracking rendering and
   * `pic://` protocol issues.
   */
  electron: string
  chromium: string
}
