import type { Filters, LayoutMode, Photo, SortMode } from '@shared/types'
import { DEFAULT_SORT, EMPTY_FILTERS } from '@shared/types'
import { sortPhotos } from '@shared/photoStore'
import { addToHistory, removeFromHistory, sanitizeHistory } from '@shared/history'

/**
 * Wall state.
 *
 * Kept as a plain reducer so every transition (open, filter, layout switch,
 * watch delta, selection) is unit-testable without mounting React.
 */
export interface WallState {
  dir: string
  photos: Photo[]
  filters: Filters
  layout: LayoutMode
  /** Wall ordering; defaults to newest first. */
  sort: SortMode
  /** Id of the photo shown in the viewer, or null. */
  selectedId: string | null
  /**
   * Whether the full-size viewer is showing.
   *
   * Kept separate from `selectedId` so that closing the viewer can leave the
   * photo focused: the arrow keys walk photos only when one is focused, and
   * tying the two together made that impossible after Escape closed the viewer.
   */
  viewerOpen: boolean
  /**
   * Whether the viewer shows the EXIF panel — a remembered preference.
   *
   * It persists across photos, across closing and reopening the viewer, and
   * across restarts (it is written to the settings file). Toggling it is the
   * user stating how they want to browse, not a comment on one photo, so it is
   * not reset per photo. Opening a specific file from outside the app turns it
   * on, since the file's details are part of what was asked for.
   */
  viewerInfo: boolean
  status: 'idle' | 'scanning' | 'ready' | 'error'
  /** Photos scanned so far, for the progress indicator. */
  scanDone: number
  errorMessage: string
  /** Persisted locale preference; `''` means follow the system. */
  locale: string
  /**
   * Recently opened folders, most recent first.
   *
   * Mirrored in reducer state rather than read from `window.photoStream` on
   * demand so that opening a folder updates the menu synchronously, and so the
   * list survives the same restore/persist cycle as every other preference.
   */
  history: string[]
  /** Whether the current library includes photos in subfolders. */
  recursive: boolean
}

export const INITIAL_STATE: WallState = {
  dir: '',
  photos: [],
  filters: EMPTY_FILTERS,
  layout: 'grid',
  sort: DEFAULT_SORT,
  selectedId: null,
  viewerOpen: false,
  viewerInfo: false,
  status: 'idle',
  scanDone: 0,
  errorMessage: '',
  locale: '',
  history: [],
  recursive: false
}

export type WallAction =
  | { type: 'scan/start'; dir: string }
  | { type: 'scan/success'; dir: string; photos: Photo[] }
  | { type: 'scan/error'; message: string }
  | { type: 'photos/delta'; photos: Photo[] }
  | { type: 'filters/set'; filters: Filters }
  | { type: 'filters/reset' }
  | { type: 'layout/set'; layout: LayoutMode }
  | { type: 'sort/set'; sort: SortMode }
  | { type: 'locale/set'; locale: string }
  | { type: 'history/add'; dir: string }
  | { type: 'history/set'; history: string[] }
  | { type: 'history/remove'; dir: string }
  | { type: 'history/clear' }
  | { type: 'recursive/set'; recursive: boolean }
  | { type: 'selection/set'; id: string | null }
  | { type: 'selection/focus'; id: string | null }
  | { type: 'selection/step'; delta: number; order: readonly string[] }
  | { type: 'viewer/open' }
  | { type: 'viewer/openWithInfo' }
  | { type: 'viewer/info'; open: boolean }
  | { type: 'viewer/close' }

export function reducer(state: WallState, action: WallAction): WallState {
  switch (action.type) {
    case 'scan/start':
      return {
        ...state,
        dir: action.dir,
        status: 'scanning',
        scanDone: 0,
        photos: [],
        selectedId: null,
        errorMessage: ''
      }

    case 'scan/success':
      return {
        ...state,
        dir: action.dir,
        photos: sortPhotos(action.photos, state.sort),
        status: 'ready',
        scanDone: action.photos.length,
        errorMessage: '',
        // Recorded here rather than at each call site, so the folder picker, a
        // drop and a restore-from-history all produce the same entry. An empty
        // scan still counts: the folder was opened successfully, it just holds
        // no JPEGs.
        history: addToHistory(state.history, action.dir)
      }

    case 'scan/error':
      return { ...state, status: 'error', errorMessage: action.message }

    case 'photos/delta': {
      const photos = sortPhotos(action.photos, state.sort)
      // A watched file may vanish while its viewer is open; never keep a dangling id.
      const stillThere = state.selectedId !== null && photos.some((photo) => photo.id === state.selectedId)
      return { ...state, photos, selectedId: stillThere ? state.selectedId : null }
    }

    case 'filters/set':
      return { ...state, filters: action.filters }

    case 'filters/reset':
      return { ...state, filters: { ...EMPTY_FILTERS } }

    case 'layout/set':
      return { ...state, layout: action.layout }

    case 'sort/set':
      // Re-sort the photos already in state: the scan result is not re-fetched,
      // and leaving them in the old order would only relabel the list.
      return { ...state, sort: action.sort, photos: sortPhotos(state.photos, action.sort) }

    case 'locale/set':
      return { ...state, locale: action.locale }

    case 'history/add':
      // Re-opening a folder moves it to the top instead of duplicating it.
      return { ...state, history: addToHistory(state.history, action.dir) }

    case 'history/set':
      // Used when restoring from disk: the stored order is already the
      // history, so it must be adopted as-is rather than replayed entry by
      // entry (which would reverse it, and cap it differently).
      return { ...state, history: sanitizeHistory(action.history) }

    case 'history/remove':
      return { ...state, history: removeFromHistory(state.history, action.dir) }

    case 'history/clear':
      return { ...state, history: [] }

    case 'recursive/set':
      // Only the preference changes here; the caller re-opens the folder, since
      // the photo list itself is produced by the main process.
      return { ...state, recursive: action.recursive }

    case 'selection/set':
      // Focusing a photo also opens it: that is what clicking a tile means. The
      // panel keeps the remembered preference rather than closing, so a user who
      // works with the details open does not lose them on every click.
      return { ...state, selectedId: action.id, viewerOpen: action.id !== null }

    case 'viewer/open':
      return state.selectedId ? { ...state, viewerOpen: true } : state

    case 'viewer/openWithInfo':
      // Used when the user opened this exact file from outside the app. It turns
      // the panel *on* and remembers that, but never turns it off.
      return state.selectedId ? { ...state, viewerOpen: true, viewerInfo: true } : state

    case 'viewer/info':
      return { ...state, viewerInfo: action.open }

    case 'viewer/close':
      // The photo stays focused so the arrow keys keep working on the wall.
      return { ...state, viewerOpen: false }

    case 'selection/focus':
      // Move the highlight without opening the viewer.
      return { ...state, selectedId: action.id }

    case 'selection/step': {
      const { order, delta } = action
      if (order.length === 0) return state
      const current = state.selectedId === null ? -1 : order.indexOf(state.selectedId)
      // With nothing selected, the first step opens the first photo.
      const next = current === -1 ? (delta > 0 ? 0 : order.length - 1) : current + delta
      const clamped = Math.min(Math.max(next, 0), order.length - 1)
      // Stepping moves to a different photo, so the panel state carries over:
      // clearing it here is what made the panel close as soon as the user
      // pressed an arrow key, even though they had opened it deliberately.
      return { ...state, selectedId: order[clamped], viewerOpen: true }
    }

    default:
      return state
  }
}
