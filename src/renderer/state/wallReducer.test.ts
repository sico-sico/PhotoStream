import { describe, expect, it } from 'vitest'
import type { Photo } from '@shared/types'
import { EMPTY_FILTERS } from '@shared/types'
import { INITIAL_STATE, reducer, type WallState } from './wallReducer'

function photo(id: string, takenAt = '2020-01-01'): Photo {
  return {
    id,
    path: `/p/${id}.jpg`,
    name: `${id}.jpg`,
    width: 100,
    height: 100,
    takenAt,
    dateSource: takenAt ? 'exif' : 'none',
    mtimeMs: 0,
    sizeBytes: 0
  }
}

describe('wallReducer', () => {
  describe('scanning', () => {
    it('enters the scanning state and clears the previous result', () => {
      const state = reducer({ ...INITIAL_STATE, photos: [photo('old')] }, { type: 'scan/start', dir: '/new' })
      expect(state.status).toBe('scanning')
      expect(state.dir).toBe('/new')
      expect(state.photos).toEqual([])
      expect(state.scanDone).toBe(0)
    })

    it('clears the selection and any error on a new scan', () => {
      const previous: WallState = { ...INITIAL_STATE, selectedId: 'x', errorMessage: 'boom' }
      const state = reducer(previous, { type: 'scan/start', dir: '/new' })
      expect(state.selectedId).toBeNull()
      expect(state.errorMessage).toBe('')
    })

    it('stores sorted photos on success', () => {
      const state = reducer(INITIAL_STATE, {
        type: 'scan/success',
        dir: '/p',
        photos: [photo('b', '2021-01-01'), photo('a', '2019-01-01')]
      })
      expect(state.status).toBe('ready')
      expect(state.photos.map((p) => p.id)).toEqual(['a', 'b'])
      expect(state.scanDone).toBe(2)
    })

    it('records an error without losing the directory', () => {
      const state = reducer({ ...INITIAL_STATE, dir: '/p' }, { type: 'scan/error', message: 'denied' })
      expect(state.status).toBe('error')
      expect(state.errorMessage).toBe('denied')
      expect(state.dir).toBe('/p')
    })
  })

  describe('watch deltas', () => {
    it('replaces the collection and re-sorts', () => {
      const scanning = reducer(INITIAL_STATE, { type: 'scan/success', dir: '/p', photos: [photo('a')] })
      const state = reducer(scanning, { type: 'photos/delta', photos: [photo('c', '2022-01-01'), photo('a')] })
      expect(state.photos.map((p) => p.id)).toEqual(['a', 'c'])
    })

    it('drops a selection whose file was deleted', () => {
      const ready = reducer(INITIAL_STATE, {
        type: 'scan/success',
        dir: '/p',
        photos: [photo('a'), photo('b')]
      })
      const selected = reducer(ready, { type: 'selection/set', id: 'a' })
      const state = reducer(selected, { type: 'photos/delta', photos: [photo('b')] })
      expect(state.selectedId).toBeNull()
    })

    it('keeps a selection that still exists', () => {
      const ready = reducer(INITIAL_STATE, {
        type: 'scan/success',
        dir: '/p',
        photos: [photo('a'), photo('b')]
      })
      const selected = reducer(ready, { type: 'selection/set', id: 'b' })
      const state = reducer(selected, { type: 'photos/delta', photos: [photo('b'), photo('c')] })
      expect(state.selectedId).toBe('b')
    })
  })

  describe('filters', () => {
    it('stores and resets filters', () => {
      const applied = reducer(INITIAL_STATE, {
        type: 'filters/set',
        filters: { from: '2020-01-01', to: '', text: 'kyoto' }
      })
      expect(applied.filters.text).toBe('kyoto')

      const reset = reducer(applied, { type: 'filters/reset' })
      expect(reset.filters).toEqual(EMPTY_FILTERS)
      expect(reset.filters).not.toBe(EMPTY_FILTERS)
    })
  })

  describe('layout and locale', () => {
    it('switches layout', () => {
      expect(reducer(INITIAL_STATE, { type: 'layout/set', layout: 'masonry' }).layout).toBe('masonry')
    })

    it('stores the locale preference, including the follow-system empty string', () => {
      const chosen = reducer(INITIAL_STATE, { type: 'locale/set', locale: 'fr' })
      expect(chosen.locale).toBe('fr')
      expect(reducer(chosen, { type: 'locale/set', locale: '' }).locale).toBe('')
    })
  })

  describe('selection', () => {
    const order = ['a', 'b', 'c']

    it('sets and clears the selection', () => {
      expect(reducer(INITIAL_STATE, { type: 'selection/set', id: 'b' }).selectedId).toBe('b')
      expect(reducer({ ...INITIAL_STATE, selectedId: 'b' }, { type: 'selection/set', id: null }).selectedId).toBeNull()
    })

    it('steps forward and backward', () => {
      const at = (id: string): WallState => ({ ...INITIAL_STATE, selectedId: id })
      expect(reducer(at('b'), { type: 'selection/step', delta: 1, order }).selectedId).toBe('c')
      expect(reducer(at('b'), { type: 'selection/step', delta: -1, order }).selectedId).toBe('a')
    })

    it('clamps at both ends instead of wrapping', () => {
      const at = (id: string): WallState => ({ ...INITIAL_STATE, selectedId: id })
      expect(reducer(at('c'), { type: 'selection/step', delta: 1, order }).selectedId).toBe('c')
      expect(reducer(at('a'), { type: 'selection/step', delta: -1, order }).selectedId).toBe('a')
    })

    it('opens the first photo when stepping forward with nothing selected', () => {
      expect(reducer(INITIAL_STATE, { type: 'selection/step', delta: 1, order }).selectedId).toBe('a')
    })

    it('opens the last photo when stepping backward with nothing selected', () => {
      expect(reducer(INITIAL_STATE, { type: 'selection/step', delta: -1, order }).selectedId).toBe('c')
    })

    it('ignores stepping on an empty wall', () => {
      const state = reducer(INITIAL_STATE, { type: 'selection/step', delta: 1, order: [] })
      expect(state).toBe(INITIAL_STATE)
    })

    it('falls back to the first photo when the selection is no longer in the order', () => {
      // Can happen when a filter hides the selected photo mid-navigation.
      const state = reducer({ ...INITIAL_STATE, selectedId: 'gone' }, {
        type: 'selection/step',
        delta: 1,
        order: ['x', 'y']
      })
      expect(state.selectedId).toBe('x')
    })
  })

  it('returns the same state for an unknown action', () => {
    const unknown = { type: 'nope' } as unknown as Parameters<typeof reducer>[1]
    expect(reducer(INITIAL_STATE, unknown)).toBe(INITIAL_STATE)
  })
})
