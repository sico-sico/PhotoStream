import type { Filters, LayoutMode, Photo } from '@shared/types'
import { EMPTY_FILTERS } from '@shared/types'
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
  /** Id of the photo shown in the viewer, or null. */
  selectedId: string | null
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
  selectedId: null,
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
  | { type: 'locale/set'; locale: string }
  | { type: 'selection/set'; id: string | null }
  | { type: 'selection/step'; delta: number; order: readonly string[] }

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
        photos: sortPhotos(action.photos),
        status: 'ready',
        scanDone: action.photos.length,
        errorMessage: ''
      }

    case 'scan/error':
      return { ...state, status: 'error', errorMessage: action.message }

    case 'photos/delta': {
      const photos = sortPhotos(action.photos)
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

    case 'locale/set':
      return { ...state, locale: action.locale }

    case 'selection/set':
      return { ...state, selectedId: action.id }

    case 'selection/step': {
      const { order, delta } = action
      if (order.length === 0) return state
      const current = state.selectedId === null ? -1 : order.indexOf(state.selectedId)
      // With nothing selected, the first step opens the first photo.
      const next = current === -1 ? (delta > 0 ? 0 : order.length - 1) : current + delta
      const clamped = Math.min(Math.max(next, 0), order.length - 1)
      return { ...state, selectedId: order[clamped] }
    }

    default:
      return state
  }
}
