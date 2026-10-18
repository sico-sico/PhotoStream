import type { Filters, LayoutMode, Photo, SortMode } from '@shared/types'
import { DEFAULT_SORT, EMPTY_FILTERS } from '@shared/types'
import { sortPhotos } from '@shared/photoStore'

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
  status: 'idle' | 'scanning' | 'ready' | 'error'
  /** Photos scanned so far, for the progress indicator. */
  scanDone: number
  errorMessage: string
  /** Persisted locale preference; `''` means follow the system. */
  locale: string
}

export const INITIAL_STATE: WallState = {
  dir: '',
  photos: [],
  filters: EMPTY_FILTERS,
  layout: 'grid',
  sort: DEFAULT_SORT,
  selectedId: null,
  viewerOpen: false,
  status: 'idle',
  scanDone: 0,
  errorMessage: '',
  locale: ''
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
  | { type: 'selection/set'; id: string | null }
  | { type: 'selection/focus'; id: string | null }
  | { type: 'selection/step'; delta: number; order: readonly string[] }
  | { type: 'viewer/open' }
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
        errorMessage: ''
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

    case 'selection/set':
      // Focusing a photo also opens it: that is what clicking a tile means.
      return { ...state, selectedId: action.id, viewerOpen: action.id !== null }

    case 'viewer/open':
      return state.selectedId ? { ...state, viewerOpen: true } : state

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
      return { ...state, selectedId: order[clamped], viewerOpen: true }
    }

    default:
      return state
  }
}
