import { describe, expect, it } from 'vitest'
import type { Photo } from '@shared/types'
import {
  CENTRE_FRACTION,
  INITIAL_SHOW_STATE,
  advance,
  focusPhoto,
  isPaused,
  showReducer,
  shownPhotos,
  type ShowState
} from './randomShow'

/**
 * The random show's state machine.
 *
 * The timing rules are the whole behaviour — a photo promotes every 8 s, the set
 * turns over every 60 s, hovering pauses — so they are checked against an
 * explicit clock rather than real timers.
 */

const VIEWPORT = { width: 1600, height: 956 }

function photo(index: number): Photo {
  return {
    id: `p${index}`,
    path: `/photos/p${index}.jpg`,
    name: `p${index}.jpg`,
    width: index % 3 === 0 ? 4000 : 6000,
    height: index % 3 === 0 ? 6000 : 4000,
    takenAt: '2020-01-01',
    dateSource: 'exif',
    mtimeMs: 0,
    sizeBytes: 0
  }
}

// Larger than the ring so "bring in something new" is always possible. A pool
// smaller than RING_SIZE is a real case too, and is covered separately.
const POOL = Array.from({ length: 400 }, (_, i) => photo(i))

function started(seed = 1, pool: Photo[] = POOL): ShowState {
  return showReducer(INITIAL_SHOW_STATE, { type: 'show/start', pool, viewport: VIEWPORT, seed, now: 1000 })
}

describe('show/start', () => {
  it('starts with a centre photo and a ring of others', () => {
    const state = started()
    expect(state.centre).not.toBeNull()
    expect(state.surrounding.length).toBeGreaterThan(0)
    expect(state.boxes).toHaveLength(state.surrounding.length)
  })

  it('never repeats the centre photo in the ring', () => {
    const state = started()
    expect(state.surrounding.map((p) => p.id)).not.toContain(state.centre!.id)
  })

  it('gives every on-screen photo a distinct id', () => {
    const state = started()
    const ids = shownPhotos(state).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps every ring photo inside the window', () => {
    const state = started()
    for (const box of state.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(VIEWPORT.width)
      expect(box.y + box.h).toBeLessThanOrEqual(VIEWPORT.height)
    }
  })

  it('sizes the centre photo to about two thirds of the window', () => {
    const state = started()
    const box = state.centreBox!
    // Contain: the *smaller* side of a landscape photo is its height, and that
    // is what lands on the fraction of the window height.
    expect(Math.min(box.w, box.h)).toBeCloseTo(VIEWPORT.height * CENTRE_FRACTION, 0)
    expect(CENTRE_FRACTION).toBeGreaterThan(0.6)
    // And it keeps its 3:2 proportions rather than being stretched.
    expect(box.w / box.h).toBeCloseTo(6000 / 4000, 6)
  })

  it('is reproducible from the same seed', () => {
    expect(started(5).centre!.id).toBe(started(5).centre!.id)
    expect(started(5).surrounding.map((p) => p.id)).toEqual(started(5).surrounding.map((p) => p.id))
  })

  it('copes with an empty pool', () => {
    const state = started(1, [])
    expect(state.centre).toBeNull()
    expect(state.surrounding).toEqual([])
  })

  it('copes with a single photo', () => {
    const state = started(1, [photo(0)])
    expect(state.centre!.id).toBe('p0')
    expect(state.surrounding).toEqual([])
  })

  it('bumps the session, so a stale timer cannot drive a new show', () => {
    expect(started().session).toBe(INITIAL_SHOW_STATE.session + 1)
  })
})

describe('advance', () => {
  it('promotes a photo that was already in the ring', () => {
    const state = started()
    const next = advance(state, { now: 1000 + 8000, photoMs: 8000, batchMs: 60000 })
    expect(next.centre!.id).not.toBe(state.centre!.id)
    // It came from the ring, which is the point: the user saw it coming rather
    // than being teleported somewhere new.
    expect(state.surrounding.map((p) => p.id)).toContain(next.centre!.id)
  })

  it('retires the outgoing centre and brings in a new one', () => {
    // It has had its turn; leaving it in the ring would slowly fill the screen
    // with photos the user has already seen.
    const state = started()
    const next = advance(state, { now: 1000 + 8000, photoMs: 8000, batchMs: 60000 })
    expect(next.surrounding.map((p) => p.id)).not.toContain(state.centre!.id)
  })

  it('does nothing before the interval elapses', () => {
    const state = started()
    expect(advance(state, { now: 1000 + 7999, photoMs: 8000, batchMs: 60000 })).toBe(state)
  })

  it('turns the ring over after the batch interval', () => {
    const state = started()
    const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
    expect(next.ringChanges).toBe(state.ringChanges + 1)
    expect(next.surrounding.map((p) => p.id)).not.toEqual(state.surrounding.map((p) => p.id))
  })

  it('prefers the turnover when both timers are due', () => {
    // Promoting first would build a ring around a centre photo that is about to
    // be replaced.
    const state = started()
    const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
    expect(next.ringChanges).toBe(1)
    expect(next.lastPromotionAt).toBe(1000 + 60000)
  })

  it('brings in photos that were not on screen before', () => {
    const state = started()
    const before = new Set(shownPhotos(state).map((p) => p.id))
    const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
    const introduced = next.surrounding.filter((p) => !before.has(p.id))
    expect(introduced.length).toBeGreaterThan(0)
  })

  it('pauses while a small photo is hovered', () => {
    const paused = showReducer(started(), { type: 'show/hover', hovering: true })
    expect(isPaused(paused)).toBe(true)
    expect(advance(paused, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })).toBe(paused)
  })

  it('survives a pool smaller than the ring', () => {
    const tiny = [photo(0), photo(1), photo(2)]
    let state = started(2, tiny)
    state = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
    expect(state.centre).not.toBeNull()
    expect(state.surrounding.every((p) => tiny.some((t) => t.id === p.id))).toBe(true)
  })
})

describe('focusPhoto', () => {
  it('promotes a clicked ring photo and refills its slot', () => {
    const state = started()
    const target = state.surrounding[2]
    const next = focusPhoto(state, target.id, 2000)
    expect(next.centre!.id).toBe(target.id)
    // The slot the promoted photo left is filled by a photo that was not on
    // screen, so the ring keeps churning instead of accumulating.
    expect(next.surrounding).toHaveLength(state.surrounding.length)
    expect(next.surrounding.map((p) => p.id)).not.toContain(target.id)
    expect(next.surrounding.map((p) => p.id)).not.toContain(state.centre!.id)
  })

  it('does not reshuffle the ring', () => {
    const state = started()
    const next = focusPhoto(state, state.surrounding[2].id, 2000)
    expect(next.ringChanges).toBe(state.ringChanges)
  })

  it('ignores a photo that is not on screen', () => {
    const state = started()
    const absent = POOL.find(
      (p) => p.id !== state.centre!.id && !state.surrounding.some((s) => s.id === p.id)
    )!
    expect(focusPhoto(state, absent.id, 2000)).toBe(state)
  })

  it('ignores the photo that is already central', () => {
    const state = started()
    expect(focusPhoto(state, state.centre!.id, 2000)).toBe(state)
  })

  it('restarts the promotion timer, so a click earns a full interval', () => {
    const state = started()
    const next = focusPhoto(state, state.surrounding[0].id, 5000)
    expect(next.lastPromotionAt).toBe(5000)
  })
})

describe('show/pool', () => {
  it('updates the pool without disturbing the current screen', () => {
    // A filter change must not yank photos away mid-look.
    const state = started()
    const next = showReducer(state, { type: 'show/pool', pool: [photo(1)] })
    expect(next.centre).toBe(state.centre)
    expect(next.surrounding).toBe(state.surrounding)
    expect(next.pool).toHaveLength(1)
  })
})

describe('show/stop', () => {
  it('clears the screen and bumps the session', () => {
    const state = started()
    const next = showReducer(state, { type: 'show/stop' })
    expect(next.centre).toBeNull()
    expect(next.surrounding).toEqual([])
    expect(next.session).toBe(state.session + 1)
  })
})
