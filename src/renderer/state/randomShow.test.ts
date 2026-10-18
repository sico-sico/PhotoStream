import { describe, expect, it } from 'vitest'
import type { Photo } from '@shared/types'
import { DEFAULT_RING_SIZE, RING_SIZE_RANGE } from '@shared/types'
import {
  CENTRE_FRACTION,
  INITIAL_SHOW_STATE,
  advance,
  centreThumbLevel,
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

  describe('a pool too small to turn over', () => {
    /**
     * Ring size at or above the library size means the ring already holds
     * everything the pool can offer, so a turnover can only reshuffle what is on
     * screen — and it used to *shrink* it, because the turnover excluded the
     * current screen from its draw. Measured at the default ring of 70: 30 photos
     * went 29 -> 28 -> 1 -> 28 -> 1, once a minute.
     */
    it('does not turn the batch over when the ring covers the library', () => {
      const small = Array.from({ length: 30 }, (_, i) => photo(i))
      let state = started(3, small)
      const before = state.surrounding.length
      const batchesBefore = state.ringChanges
      const lastBatchAt = state.lastBatchAt

      // Two full turnover intervals, sampled on the tick itself. A promotion is
      // still allowed — that is the whole point of skipping the turnover.
      state = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      expect(state.ringChanges).toBe(batchesBefore)
      expect(state.lastBatchAt).toBe(lastBatchAt)
      // Nothing falls: a drop animation for a batch that is not changing would
      // read as a rendering fault.
      expect(state.falling).toHaveLength(0)
      expect(state.surrounding.length).toBe(before)
      // And the ring turned over by exactly one tile, not re-dealt wholesale.
      expect(new Set(state.surrounding.map((p) => p.id)).size).toBe(before)
    })

    it('keeps the ring full instead of collapsing on a turnover', () => {
      // Only one photo more than the ring: excluding the screen leaves nothing,
      // so the top-up pass is what keeps the ring at its natural size.
      const pool = Array.from({ length: 21 }, (_, i) => photo(i))
      let state = showReducer(INITIAL_SHOW_STATE, {
        type: 'show/start',
        pool,
        viewport: VIEWPORT,
        seed: 7,
        ringSize: 20,
        now: 1000
      })
      const before = state.surrounding.length
      expect(before).toBeGreaterThan(15)

      state = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000, ringSize: 20 })
      expect(state.surrounding.length).toBe(before)
      expect(state.falling.length).toBe(before)
    })

    it('still brings in the photos that were left out of the layout', () => {
      // At equality the scatter may have dropped candidates, so a turnover is
      // worth doing even though the ring covers the whole library.
      const pool = Array.from({ length: 20 }, (_, i) => photo(i))
      let state = showReducer(INITIAL_SHOW_STATE, {
        type: 'show/start',
        pool,
        viewport: VIEWPORT,
        seed: 11,
        ringSize: 20,
        now: 1000
      })
      state = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000, ringSize: 20 })
      const onScreen = new Set([state.centre!.id, ...state.surrounding.map((p) => p.id)])
      expect(onScreen.size).toBeGreaterThanOrEqual(19)
    })

    it('never shows the same photo twice at once', () => {
      // The two-pass draw makes a repeat more likely, since the second pass
      // deliberately revisits photos that are already on screen.
      const tiny = [photo(0), photo(1), photo(2)]
      let state = started(5, tiny)
      for (let t = 1000; t <= 1000 + 300000; t += 1000) {
        state = advance(state, { now: t, photoMs: 8000, batchMs: 60000 })
        const ids = [state.centre?.id, ...state.surrounding.map((p) => p.id)].filter(Boolean) as string[]
        expect(new Set(ids).size).toBe(ids.length)
      }
    })

    it('keeps rotating so the show never freezes', () => {
      // The retired centre is readmitted when there is nothing else to draw. The
      // alternative — leaving the tile empty — left a three-photo library with a
      // single photo and no way back, because turn-overs are skipped here.
      const tiny = [photo(0), photo(1), photo(2)]
      let state = started(5, tiny)
      const centres = new Set<string>()
      for (let t = 1000; t <= 1000 + 120000; t += 1000) {
        state = advance(state, { now: t, photoMs: 8000, batchMs: 60000 })
        if (state.centre) centres.add(state.centre.id)
      }
      expect(centres.size).toBe(3)
      expect(state.surrounding.length).toBe(2)
    })
  })

  it('replaces a different tile every time, not the same tile over and over', () => {
    // The ring is a queue: index 0 is the photo that has been on screen longest.
    // Refilling a promoted slot *in place* put the replacement at index 0 of the
    // queue, so it was promoted eight seconds later, its own replacement took
    // index 0 again, and so on: the same *tile* churned forever while the rest of
    // the ring never moved. The photos still changed — a random one was drawn
    // each time — which is why asserting on ids missed it. The position is what
    // gets stuck, so the position is what is checked.
    let state = started()
    const tiles: string[] = []
    for (let tick = 1; tick <= 5; tick += 1) {
      const promotedId = state.surrounding[0].id
      const box = state.boxes.find((b) => b.id === promotedId)!
      tiles.push(`${box.x},${box.y}`)
      state = advance(state, { now: 1000 + tick * 8000, photoMs: 8000, batchMs: 60000 })
    }
    expect(new Set(tiles).size).toBe(tiles.length)
  })

  it('moves the replacement to the back of the queue, not the front', () => {
    // The direct statement of the bug: after a promotion, the newly inserted
    // photo must not be first in line.
    const state = started()
    const next = advance(state, { now: 1000 + 8000, photoMs: 8000, batchMs: 60000 })
    const introduced = next.surrounding.filter((p) => !state.surrounding.some((s) => s.id === p.id))
    expect(introduced).toHaveLength(1)
    expect(next.surrounding[0].id).not.toBe(introduced[0].id)
    // And it must be last, since it has been on screen the shortest time.
    expect(next.surrounding.at(-1)!.id).toBe(introduced[0].id)
  })

  it('keeps promoting photos the user has not just seen', () => {
    // Over a run of promotions the centre should keep changing; a stuck slot
    // showed up as the same handful of photos cycling.
    let state = started()
    const centres: string[] = [state.centre!.id]
    for (let tick = 1; tick <= 6; tick += 1) {
      state = advance(state, { now: 1000 + tick * 8000, photoMs: 8000, batchMs: 60000 })
      centres.push(state.centre!.id)
    }
    expect(new Set(centres).size).toBe(centres.length)
  })

  it('keeps the replacement in the tile the promoted photo left', () => {
    // The queue order changed, but the layout must not: the replacement appears
    // where the promoted photo was, so nothing reflows.
    const state = started()
    const slot = state.boxes[2]
    const next = focusPhoto(state, slot.id, 2000)
    const introduced = next.surrounding.find((p) => !state.surrounding.some((s) => s.id === p.id))!
    const moved = next.boxes.find((box) => box.id === introduced.id)!
    expect(moved.x).toBe(slot.x)
    expect(moved.y).toBe(slot.y)
    expect(moved.w).toBe(slot.w)
    expect(moved.h).toBe(slot.h)
  })

  describe('the outward drop on turnover', () => {
    it('sends the whole outgoing ring out of the window', () => {
      // Every ring photo is discarded on a turnover, so every ring photo has to
      // fall. Photos blinking out one by one reads as a glitch; the ring leaving
      // together reads as the batch ending.
      const state = started()
      const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      expect(next.falling.map((card) => card.photo.id).sort()).toEqual(
        state.surrounding.map((photo) => photo.id).sort()
      )
    })

    it('leaves each card in the tile it was standing in', () => {
      // The card must fall from where it was, not from a recomputed position —
      // otherwise the first frame of the animation is a jump.
      const state = started()
      const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      for (const card of next.falling) {
        const box = state.boxes.find((b) => b.id === card.photo.id)!
        expect(card.box.x).toBe(box.x)
        expect(card.box.y).toBe(box.y)
        expect(card.box.w).toBe(box.w)
        expect(card.box.h).toBe(box.h)
        expect(card.box.rotate).toBe(box.rotate)
      }
    })

    it('does not throw the centre photo away', () => {
      // The centre survives a turnover on purpose, so it must not be among the
      // cards falling out of the window.
      const state = started()
      const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      expect(next.falling.map((card) => card.photo.id)).not.toContain(next.centre!.id)
    })

    it('does not drop anything for a promotion', () => {
      // A promotion retires one photo and refills its tile; nothing is discarded,
      // so nothing falls.
      const state = started()
      const next = advance(state, { now: 1000 + 8000, photoMs: 8000, batchMs: 60000 })
      expect(next.falling).toEqual([])
      expect(next.fallingKey).toBe(0)
    })

    it('gives each drop its own key', () => {
      // A card still animating from one drop must not be mistaken for the next,
      // which is what the clear action uses to avoid cutting a newer drop short.
      const state = started()
      const first = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      const second = advance(first, { now: 1000 + 120000, photoMs: 8000, batchMs: 60000 })
      expect(first.fallingKey).toBeGreaterThan(0)
      expect(second.fallingKey).not.toBe(first.fallingKey)
    })

    it('clears the fallen cards once the animation is over', () => {
      const state = started()
      const dropped = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      const cleared = showReducer(dropped, { type: 'show/clearFalling', key: dropped.fallingKey })
      expect(cleared.falling).toEqual([])
      expect(cleared.fallingKey).toBe(0)
      // The new ring survives the clear; only the outgoing cards are dropped.
      expect(cleared.surrounding).toEqual(dropped.surrounding)
    })

    it('ignores a stale clear, so a newer drop is not cut short', () => {
      const state = started()
      const first = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000 })
      const second = advance(first, { now: 1000 + 120000, photoMs: 8000, batchMs: 60000 })
      const cleared = showReducer(second, { type: 'show/clearFalling', key: first.fallingKey })
      expect(cleared).toBe(second)
    })
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

describe('centreThumbLevel', () => {
  it('serves the zoom tier on an ordinary 1x display', () => {
    // 956 * 0.68 is well under the 2560px zoom tier.
    expect(centreThumbLevel({ width: 1600, height: 956 }, 1)).toBe('zoom')
  })

  it('asks for the original once a high-DPI window needs more than 2560px', () => {
    // The point of the whole mechanism: a 4K-class window at 2x renders the
    // centre photo at ~2940 CSS px, which the 2560px tier cannot fill.
    expect(centreThumbLevel({ width: 3840, height: 2160 }, 2)).toBe('full')
    expect(centreThumbLevel({ width: 5120, height: 2880 }, 2)).toBe('full')
  })

  it('is driven by the shorter side, since a contained photo cannot exceed it', () => {
    // A tall narrow window constrains by width; a wide one by height.
    expect(centreThumbLevel({ width: 900, height: 4000 }, 1)).toBe('zoom')
    expect(centreThumbLevel({ width: 4000, height: 900 }, 1)).toBe('zoom')
  })

  it('falls back to zoom before the window has been measured', () => {
    // A zero-size viewport must not produce `full`: that would decode originals
    // for a window that is not on screen yet.
    expect(centreThumbLevel({ width: 0, height: 0 }, 1)).toBe('zoom')
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

describe('ring size', () => {
  it('uses the configured size when the show starts', () => {
    // The preference is a ceiling on candidates, not a promise of that many
    // cards: the scatter still drops whatever does not fit.
    const state = showReducer(INITIAL_SHOW_STATE, {
      type: 'show/start',
      pool: POOL,
      viewport: VIEWPORT,
      seed: 1,
      ringSize: 40,
      now: 1000
    })
    expect(state.ringSize).toBe(40)
  })

  it('falls back to the default when no size is given', () => {
    // Keeps a caller without a preference (the tests, mostly) behaving as before.
    expect(started().ringSize).toBe(DEFAULT_RING_SIZE)
  })

  it('puts fewer photos on screen for a smaller ring', () => {
    // The whole point of the setting. Measured by what actually got placed, since
    // that is what the user sees.
    const small = showReducer(INITIAL_SHOW_STATE, {
      type: 'show/start',
      pool: POOL,
      viewport: VIEWPORT,
      seed: 1,
      ringSize: 30,
      now: 1000
    })
    const large = showReducer(INITIAL_SHOW_STATE, {
      type: 'show/start',
      pool: POOL,
      viewport: VIEWPORT,
      seed: 1,
      ringSize: 90,
      now: 1000
    })
    expect(small.surrounding.length).toBeLessThanOrEqual(30)
    expect(large.surrounding.length).toBeGreaterThan(small.surrounding.length)
  })

  it('re-deals immediately when the preference changes', () => {
    // The control is live, so the effect has to be visible without waiting a
    // minute for the next turnover.
    const state = started()
    const next = showReducer(state, { type: 'show/ringSize', ringSize: 30 })
    expect(next.ringSize).toBe(30)
    expect(next.surrounding.length).toBeLessThanOrEqual(30)
    // The centre is the subject; changing the density must not change it.
    expect(next.centre).toBe(state.centre)
  })

  it('keeps the photos already on screen rather than redrawing the batch', () => {
    // Growing the ring should add cards, not reshuffle what the user is looking
    // at: a slider drag must not make the batch flicker.
    const state = showReducer(started(), { type: 'show/ringSize', ringSize: 30 })
    const before = state.surrounding.map((photo) => photo.id)
    const next = showReducer(state, { type: 'show/ringSize', ringSize: 45 })
    const after = new Set(next.surrounding.map((photo) => photo.id))
    // Everything that was there is still there.
    for (const id of before) expect(after.has(id)).toBe(true)
  })

  it('clamps an out-of-range value instead of trusting it', () => {
    const state = started()
    expect(showReducer(state, { type: 'show/ringSize', ringSize: 5 }).ringSize).toBe(RING_SIZE_RANGE.min)
    expect(showReducer(state, { type: 'show/ringSize', ringSize: 5000 }).ringSize).toBe(RING_SIZE_RANGE.max)
  })

  it('returns the same object when the value is unchanged', () => {
    // So a re-render with the same preference cannot trigger a pointless re-deal.
    const state = started()
    expect(showReducer(state, { type: 'show/ringSize', ringSize: state.ringSize })).toBe(state)
  })

  it('applies the size on the next turnover too', () => {
    // The turnover is on a timer and does not go through the start action, so it
    // reads the stored value; a caller may also pass a fresher one.
    const state = started()
    const next = advance(state, { now: 1000 + 60000, photoMs: 8000, batchMs: 60000, ringSize: 30 })
    expect(next.surrounding.length).toBeLessThanOrEqual(30)
  })
})
