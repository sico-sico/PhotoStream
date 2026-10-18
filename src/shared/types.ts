/** Where the capture date came from. `exif` is authoritative; `none` means unknown. */
export type DateSource = 'exif' | 'none'

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
}

export const DEFAULT_SETTINGS: Settings = {
  lastDir: '',
  layout: 'grid',
  sort: DEFAULT_SORT,
  filters: EMPTY_FILTERS,
  locale: ''
}

/**
 * Which rendition of a photo to show.
 *
 * `wall` and `zoom` are cached WebP thumbnails; `full` streams the original
 * file, which is the only way to stay sharp at high magnification.
 */
export type ThumbLevel = 'wall' | 'zoom' | 'full'

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
}
