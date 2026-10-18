import { centreBoxFor, mulberry32, pickRandom, scatterAround, type Box, type ScatterBox } from '@shared/random'
import { pickThumbLevel } from '@shared/thumbs'
import { DEFAULT_RING_SIZE, clampRingSize } from '@shared/types'
import type { Photo, ThumbLevel } from '@shared/types'

/**
 * The random show's state.
 *
 * Kept as a pure reducer for the same reason `wallReducer` is: the behaviour that
 * matters is timing — promote every 8 s, turn the set over every 60 s, pause on
 * hover — and timing is easy to get wrong and hard to test through a component.
 * `advance` takes the clock as an argument, so every rule can be checked without
 * waiting for it.
 */

/**
 * How many photos ring the centre one, when the caller does not say.
 *
 * The scatter decides how many actually fit, so this is a ceiling rather than a
 * promise: at 2560x1440 about 63 of 90 candidates find a slot. The live value
 * comes from the user's `ringSize` setting via `ShowOptions.ringSize`; this
 * constant is the fallback for the tests and for a caller that has no preference
 * to offer.
 */
export const RING_SIZE = DEFAULT_RING_SIZE

/**
 * Fraction of the window's shorter side the centre photo occupies.
 *
 * Larger than the original half: the centre photo is the subject, and at half the
 * window it read as one tile among many. The ring is allowed to sit underneath
 * its edges (see `maxOverlap`), so the extra size does not simply push the small
 * photos off screen.
 */
export const CENTRE_FRACTION = 0.68

/**
 * A photo on its way out of the window.
 *
 * Only a turnover produces these. Retiring one photo into another tile (a
 * promotion) is a move within the ring and is transitioned, not thrown away;
 * replacing *every* ring photo at once needs a gesture that reads as one event,
 * and that gesture is the whole ring dropping out of the bottom.
 *
 * The card keeps the box it had, so it leaves from exactly where it was rather
 * than from a recomputed position, and it keeps the photo so the image can still
 * be drawn while it falls.
 */
export interface FallingCard {
  /** Unique per turnover, so a card from an old batch cannot reanimate. */
  key: string
  photo: Photo
  box: ScatterBox
}

export interface ShowState {
  /** Incremented on every start/stop, so a stale timer cannot drive a new session. */
  session: number
  centre: Photo | null
  centreBox: Box | null
  /** Photos in the ring, excluding the centre. */
  surrounding: Photo[]
  boxes: ScatterBox[]
  /**
   * The previous ring, mid-fall.
   *
   * Held in state rather than derived in the component because the reducer is the
   * only place that knows the ring is being replaced, and it has the outgoing
   * boxes right there. Cleared by `show/clearFalling` once the animation is over.
   */
  falling: FallingCard[]
  /** Timestamp that identifies the current drop; 0 when nothing is falling. */
  fallingKey: number
  /** Everything the show may draw from; the caller keeps it in sync with filters. */
  pool: Photo[]
  /**
   * Ceiling on how many photos ring the centre one, from the user's preference.
   *
   * Held in state because a turnover happens on a timer, outside any render, so
   * the value has to be reachable from the reducer without the component passing
   * it again. `show/ringSize` updates it and re-deals immediately.
   */
  ringSize: number
  viewport: { width: number; height: number }
  seed: number
  /** Clock value for each timer, in milliseconds. */
  startedAt: number
  lastPromotionAt: number
  lastBatchAt: number
  ringChanges: number
  /** Promotions since the show started, used only to reseed the RNG. */
  promotions: number
  /** True while the pointer rests on one of the small photos. */
  hovering: boolean
}

export const INITIAL_SHOW_STATE: ShowState = {
  session: 0,
  centre: null,
  centreBox: null,
  surrounding: [],
  boxes: [],
  falling: [],
  fallingKey: 0,
  pool: [],
  ringSize: DEFAULT_RING_SIZE,
  viewport: { width: 0, height: 0 },
  seed: 1,
  startedAt: 0,
  lastPromotionAt: 0,
  lastBatchAt: 0,
  ringChanges: 0,
  promotions: 0,
  hovering: false
}

export type ShowAction =
  | {
      type: 'show/start'
      pool: readonly Photo[]
      viewport: { width: number; height: number }
      seed: number
      /** How many photos to ring the centre one; falls back to `RING_SIZE`. */
      ringSize?: number
      now?: number
    }
  | { type: 'show/pool'; pool: readonly Photo[] }
  | { type: 'show/ringSize'; ringSize: number }
  | { type: 'show/hover'; hovering: boolean }
  | { type: 'show/resize'; viewport: { width: number; height: number } }
  /** Drops the fallen cards once they are out of sight. `key` guards staleness. */
  | { type: 'show/clearFalling'; key: number }
  | { type: 'show/stop' }

export interface ShowOptions {
  now: number
  photoMs: number
  batchMs: number
  /**
   * How many photos to arrange around the centre one on a turnover.
   *
   * Passed in rather than read from settings here: the reducer is a pure function
   * and the preference lives in the renderer. Falls back to `RING_SIZE` so a
   * caller with no preference (the tests, mostly) behaves as before.
   */
  ringSize?: number
}

const aspectOf = (photo: Photo): number =>
  Number.isFinite(photo.width) && Number.isFinite(photo.height) && photo.height > 0
    ? photo.width / photo.height
    : 1

/**
 * Which rendition the centre photo needs for a given window.
 *
 * The centre photo is drawn at `CENTRE_FRACTION` of the window's shorter side, so
 * the pixels actually demanded are known before the image loads — and on a large
 * or high-DPI display that demand exceeds the 2560px `zoom` tier. Measured:
 * 2160px @2x and 2880px @2x both need `full`, while every 1x display is served by
 * `zoom`.
 *
 * A fixed `zoom` would therefore look soft on exactly the displays where the show
 * is most impressive. `pickThumbLevel` already answers this question for the wall,
 * so it is reused rather than reimplemented.
 *
 * @param dpr device pixel ratio; a 2x screen needs twice the pixels of a 1x one
 */
export function centreThumbLevel(viewport: { width: number; height: number }, dpr = 1): ThumbLevel {
  const shorter = Math.min(viewport.width, viewport.height)
  if (!(shorter > 0)) return 'zoom'
  // The long edge of a contained photo cannot exceed the shorter side of the
  // window; that is the worst case and the one worth sizing for.
  return pickThumbLevel(shorter * CENTRE_FRACTION, 1, dpr)
}

/** Nothing advances while the user is inspecting a small photo. */
export function isPaused(state: ShowState): boolean {
  return state.hovering
}

/**
 * Build the ring around `centre`.
 *
 * @param exclude ids that must not appear — the centre itself, and on a turnover
 *   the photos that were just on screen
 */
function layout(
  centre: Photo,
  pool: readonly Photo[],
  viewport: { width: number; height: number },
  exclude: ReadonlySet<string>,
  rng: () => number,
  ringSize: number = RING_SIZE
): { surrounding: Photo[]; boxes: ScatterBox[]; centreBox: Box } {
  const candidates = pickRandom(pool, ringSize, rng, exclude, (photo) => photo.id).map((photo) => ({
    id: photo.id,
    aspect: aspectOf(photo)
  }))
  const centreBox = centreBoxFor(aspectOf(centre), viewport, CENTRE_FRACTION)
  const boxes = scatterAround({ candidates, viewport, centre: centreBox, rng })
  const byId = new Map(pool.map((photo) => [photo.id, photo]))
  return {
    boxes,
    centreBox,
    surrounding: boxes
      .map((box) => byId.get(box.id))
      .filter((photo): photo is Photo => photo !== undefined)
  }
}

export function showReducer(state: ShowState, action: ShowAction): ShowState {
  switch (action.type) {
    case 'show/start': {
      const now = action.now ?? Date.now()
      const empty: ShowState = {
        ...INITIAL_SHOW_STATE,
        session: state.session + 1,
        viewport: action.viewport,
        seed: action.seed
      }
      if (action.pool.length === 0) return empty

      const rng = mulberry32(action.seed)
      const centre = pickRandom(action.pool, 1, rng)[0]
      const ringSize = action.ringSize ?? RING_SIZE
      const ring = layout(centre, action.pool, action.viewport, new Set([centre.id]), rng, ringSize)
      return {
        ...empty,
        ringSize,
        pool: [...action.pool],
        startedAt: now,
        lastPromotionAt: now,
        lastBatchAt: now,
        centre,
        centreBox: ring.centreBox,
        surrounding: ring.surrounding,
        boxes: ring.boxes
      }
    }

    case 'show/pool':
      // Filters changed. The pool is updated but the current screen is left
      // alone: replacing photos mid-look would be more jarring than letting the
      // next turnover take effect.
      return { ...state, pool: [...action.pool] }

    case 'show/ringSize': {
      const ringSize = clampRingSize(action.ringSize)
      if (ringSize === state.ringSize) return state
      if (!state.centre) return { ...state, ringSize }
      /*
       * Re-deal immediately rather than waiting for the next turnover.
       *
       * The setting is a live control, so the user has to see its effect while
       * looking at it; deferring would make "30" and "90" look identical until a
       * minute had passed. The photos already on screen are kept as the starting
       * set, so shrinking the ring only removes cards and growing it only adds —
       * the current batch does not reshuffle under the pointer.
       *
       * The fallen cards are cleared: a drop in flight belongs to the previous
       * layout and would otherwise land on top of the new one.
       */
      const rng = mulberry32(state.seed + state.ringChanges * 7919 + state.promotions * 104729 + 17)
      const centreBox = centreBoxFor(aspectOf(state.centre), state.viewport, CENTRE_FRACTION)
      // Fewer candidates than the ring already holds means the extra cards go;
      // more means the layout has room to place them.
      const candidates = pickRandom(state.pool, ringSize, rng, new Set([state.centre.id]), (photo) => photo.id).map(
        (photo) => ({ id: photo.id, aspect: aspectOf(photo) })
      )
      const boxes = scatterAround({ candidates, viewport: state.viewport, centre: centreBox, rng })
      const byId = new Map(state.pool.map((photo) => [photo.id, photo]))
      return {
        ...state,
        ringSize,
        centreBox,
        boxes,
        surrounding: boxes
          .map((box) => byId.get(box.id))
          .filter((photo): photo is Photo => photo !== undefined),
        falling: [],
        fallingKey: 0
      }
    }

    case 'show/hover':
      return state.hovering === action.hovering ? state : { ...state, hovering: action.hovering }

    case 'show/clearFalling':
      // Ignore a clear for a drop that has already been superseded: the newer
      // cards must not be removed early by a stale timer.
      if (state.fallingKey !== action.key) return state
      if (state.falling.length === 0) return state
      return { ...state, falling: [], fallingKey: 0 }

    case 'show/resize': {
      if (!state.centre) return { ...state, viewport: action.viewport }
      // Re-place the same ring for the new window, so nothing new appears just
      // because the window was resized.
      const rng = mulberry32(state.seed + state.ringChanges * 7919 + 13)
      const centreBox = centreBoxFor(aspectOf(state.centre), action.viewport, CENTRE_FRACTION)
      const candidates = state.surrounding.map((photo) => ({ id: photo.id, aspect: aspectOf(photo) }))
      const boxes = scatterAround({ candidates, viewport: action.viewport, centre: centreBox, rng })
      const byId = new Map(state.surrounding.map((photo) => [photo.id, photo]))
      return {
        ...state,
        viewport: action.viewport,
        centreBox,
        boxes,
        surrounding: boxes
          .map((box) => byId.get(box.id))
          .filter((photo): photo is Photo => photo !== undefined)
      }
    }

    case 'show/stop':
      return { ...INITIAL_SHOW_STATE, session: state.session + 1 }

    default:
      return state
  }
}

/**
 * Advance the timers.
 *
 * Returns the same object when nothing is due, so a caller can use reference
 * equality to skip a render.
 */
export function advance(state: ShowState, options: ShowOptions): ShowState {
  const { now, photoMs, batchMs } = options
  if (!state.centre || isPaused(state)) return state

  if (now - state.lastBatchAt >= batchMs) {
    // The batch wins on a shared tick: promoting first would build a ring around
    // a centre photo that is about to be replaced.
    const exclude = new Set([state.centre.id, ...state.surrounding.map((photo) => photo.id)])
    const rng = mulberry32(state.seed + (state.ringChanges + 1) * 7919 + now)
    const ring = layout(
      state.centre,
      state.pool,
      state.viewport,
      exclude,
      rng,
      options.ringSize ?? state.ringSize
    )

    /*
     * The whole ring, not just the centre, leaves by falling out of the bottom.
     *
     * Everything on screen except the centre photo is thrown away on a turnover,
     * so animating the removal as a single event — all of them dropping together —
     * is what makes it read as "this batch ended" rather than as ninety separate
     * photos flickering out. The centre is not thrown away: it survives the batch
     * on purpose, so it must stay put.
     *
     * The boxes are the outgoing ones, captured before `layout` replaces them, so
     * each card falls from where it actually was.
     */
    const byId = new Map(state.surrounding.map((photo) => [photo.id, photo]))
    const falling: FallingCard[] = state.boxes.flatMap((box) => {
      const photo = byId.get(box.id)
      return photo ? [{ key: `${now}-${box.id}`, photo, box }] : []
    })

    return {
      ...state,
      lastPromotionAt: now,
      lastBatchAt: now,
      ringChanges: state.ringChanges + 1,
      centreBox: ring.centreBox,
      surrounding: ring.surrounding,
      boxes: ring.boxes,
      falling,
      // A fresh key per drop, so a card still animating from a previous drop
      // cannot be mistaken for one of these.
      fallingKey: falling.length > 0 ? now : 0
    }
  }

  if (now - state.lastPromotionAt >= photoMs && state.surrounding.length > 0) {
    // The photo that has been on screen longest is promoted, so the sequence
    // reads in the order the user saw them.
    return focusPhoto(state, state.surrounding[0].id, now)
  }

  return state
}

/**
 * Promote `id` to the centre, replacing it in the ring with a fresh photo.
 *
 * The outgoing centre is *not* kept in the ring: it has had its turn, and leaving
 * it behind would slowly turn the screen into "everything I have already seen
 * today". Taking a new photo from the pool instead keeps the ring churning, which
 * is the point of a random show — every promotion shows something that was not on
 * screen a moment ago as well as something that was.
 *
 * The new photo takes the promoted photo's slot, so the layout does not reflow.
 */
export function focusPhoto(state: ShowState, id: string, now = state.lastPromotionAt): ShowState {
  if (!state.centre || id === state.centre.id) return state
  const promoted = state.surrounding.find((photo) => photo.id === id)
  if (!promoted) return state

  const outgoing = state.centre
  const onScreen = new Set([outgoing.id, ...state.surrounding.map((photo) => photo.id)])

  // Prefer something not already on screen. A large RING_SIZE can consume most of
  // a small pool, so this legitimately runs dry; in that case the slot is simply
  // left empty rather than refilled with a photo the user just finished looking
  // at. Shrinking the ring by one is honest — the alternative is a screen that
  // slowly refills with its own history.
  const rng = mulberry32(state.seed + (state.promotions + 1) * 104729 + now)
  const [replacement] = pickRandom(state.pool, 1, rng, onScreen, (photo) => photo.id)

  const surrounding = replacement
    ? [...state.surrounding.filter((photo) => photo.id !== id), replacement]
    : state.surrounding.filter((photo) => photo.id !== id)

  /*
   * The new photo keeps the promoted photo's tile, so the ring does not reflow:
   * one photo leaves, another takes its place in the same position.
   *
   * Note that `boxes` and `surrounding` are deliberately in different orders.
   * `boxes` is the layout — a box keeps its coordinates so the replacement
   * appears where the promoted photo was. `surrounding` is the *queue*: index 0
   * is the photo that has been on screen longest, which is the one `advance`
   * promotes next. Appending the replacement is what makes that true.
   */
  const boxes = replacement
    ? state.boxes.map((box) => (box.id === id ? { ...box, id: replacement.id } : box))
    : state.boxes.filter((box) => box.id !== id)

  return {
    ...state,
    centre: promoted,
    centreBox: centreBoxFor(aspectOf(promoted), state.viewport, CENTRE_FRACTION),
    surrounding,
    boxes,
    lastPromotionAt: now,
    promotions: state.promotions + 1
  }
}

/** Every photo currently on screen, centre first. */
export function shownPhotos(state: ShowState): Photo[] {
  return state.centre ? [state.centre, ...state.surrounding] : [...state.surrounding]
}
