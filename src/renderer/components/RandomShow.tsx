import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo, ThumbLevel } from '@shared/types'
import { useI18n } from '../i18n/context'
import {
  INITIAL_SHOW_STATE,
  RING_SIZE,
  advance,
  centreThumbLevel,
  focusPhoto,
  isPaused,
  shownPhotos,
  showReducer
} from '../state/randomShow'

export interface RandomShowProps {
  /** Photos the show may draw from — the caller passes the filtered set. */
  pool: readonly Photo[]
  /**
   * URLs at every tier, so the centre photo can be served at the resolution its
   * displayed size demands.
   *
   * The centre covers about two thirds of the window, and whether that needs the
   * 2560px `zoom` tier or the original depends on the display: measured, every 1x
   * window is fine with `zoom`, while 2160px at 2x wants `full`. A fixed tier
   * would be soft on exactly the screens where the show looks best.
   *
   * The ring stays on the wall tier: it is small on screen, and using a sharper
   * tier there would multiply memory for no visible gain.
   */
  urlMapsByLevel: Record<ThumbLevel, Record<string, string>>
  /**
   * How many photos to ring the centre one.
   *
   * A live preference: changing it re-deals the ring at once, so the setting can
   * be dragged while the show is open and its effect seen immediately.
   */
  ringSize?: number
  /** Called when the on-screen set changes, so the caller can request thumbnails. */
  onShow: (photos: readonly Photo[], level: ThumbLevel) => void
  onClose: () => void
}

/** How long a photo stays centred before a neighbour takes over. */
export const PHOTO_INTERVAL_MS = 8000

/** How long a ring lasts before a fresh set is drawn. */
export const BATCH_INTERVAL_MS = 60000

/** Timer resolution. Fine enough for an 8 s interval, cheap enough to idle on. */
const TICK_MS = 250

/**
 * How long the outgoing batch takes to fall out of the window.
 *
 * Must stay in step with the `random-show-fall` animation in the stylesheet: it
 * is the point at which the falling cards are removed from state. Slightly longer
 * than the animation so the last frame is never cut off.
 */
export const FALL_DURATION_MS = 1150

/**
 * Full-window random show.
 *
 * One photo centred at about half the window, ringed by smaller ones of varying
 * size, so the screen has a focal point without being a slideshow. It advances on
 * its own — a neighbour promotes every 8 s, the ring turns over every 60 s — and
 * clicking any photo brings it to the centre.
 *
 * The behaviour lives in `state/randomShow`; this component owns the timer, the
 * pointer tracking and the DOM. State is held with `useState` and updated only
 * through the exported pure functions, so the reducer's "return the same object
 * when nothing is due" contract turns into an automatic skipped render.
 */
export function RandomShow({
  pool,
  urlMapsByLevel,
  ringSize = RING_SIZE,
  onShow,
  onClose
}: RandomShowProps): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState(INITIAL_SHOW_STATE)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Measure the window: the scatter is computed in pixels.
  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      if (!(rect.width > 0) || !(rect.height > 0)) return
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      /*
       * Only write when the numbers move.
       *
       * `ResizeObserver` delivers an initial notification right after
       * `observe()`, and more whenever the overlay's box changes. Storing a
       * fresh object every time changed the state's identity without changing
       * its value, which re-ran the start effect below — and that effect draws a
       * new centre photo and a whole new ring. The visible result was the ring
       * being dealt twice on every open, and a rapid reshuffle whenever the
       * window was still settling.
       */
      setViewport((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Draw the first ring, once per visit.
   *
   * Guarded by a ref rather than by the dependency array alone: the effect has
   * to wait for a measured window and a non-empty pool, so it legitimately runs
   * more than once early on, and only the first pass may deal cards. Re-seeding
   * is a visible event — every photo on screen is replaced — so it must happen
   * on entry, not on every resize.
   */
  const started = useRef(false)
  /** The pool the ring was dealt from, so an unchanged pool is not re-sent. */
  const dealtFrom = useRef<readonly Photo[] | null>(null)
  useEffect(() => {
    if (started.current) return
    if (viewport.width === 0 || viewport.height === 0 || pool.length === 0) return
    started.current = true
    dealtFrom.current = pool
    setState((previous) =>
      showReducer(previous, {
        type: 'show/start',
        pool,
        viewport,
        ringSize,
        seed: (Date.now() & 0x7fffffff) >>> 0
      })
    )
  }, [pool, viewport, ringSize])

  /**
   * Keep the candidate pool current without disturbing what is on screen.
   *
   * The wall replaces its photo array whenever a file is added, removed or
   * re-scanned, and `visiblePhotos` means the filters can shrink it too. Feeding
   * that through `show/pool` updates the pool for the next turnover while the
   * current ring keeps playing; re-seeding instead would empty and refill the
   * screen for an event the user did not ask for.
   */
  useEffect(() => {
    if (!started.current) return
    if (dealtFrom.current === pool) return
    dealtFrom.current = pool
    setState((previous) => showReducer(previous, { type: 'show/pool', pool }))
  }, [pool])

  /*
   * A changed preference re-deals the ring now.
   *
   * Separate from the start effect on purpose: that one re-seeds and would get a
   * brand new set of photos, while dragging the slider must only add or remove
   * cards. `show/ringSize` keeps what is already on screen and rescatters it.
   */
  useEffect(() => {
    setState((previous) => showReducer(previous, { type: 'show/ringSize', ringSize }))
  }, [ringSize])

  // A resize re-places the same ring rather than drawing a new one.
  useEffect(() => {
    if (viewport.width === 0) return
    setState((previous) => showReducer(previous, { type: 'show/resize', viewport }))
  }, [viewport])

  /**
   * Drive the timers.
   *
   * One tick rather than two timeouts: the intervals interact — a turnover resets
   * the promotion timer — and a single clock makes that ordering explicit rather
   * than depending on which timeout happens to fire first.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      setState((previous) =>
        advance(previous, {
          now: Date.now(),
          photoMs: PHOTO_INTERVAL_MS,
          batchMs: BATCH_INTERVAL_MS,
          ringSize
        })
      )
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [ringSize])

  // Escape leaves, matching the viewer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const shown = useMemo(() => shownPhotos(state), [state])

  /**
   * The tier the centre photo needs on this display.
   *
   * Recomputed on resize and DPR change rather than fixed, because the answer
   * genuinely differs: `zoom` is enough at 1x, and a large high-DPI window wants
   * the original.
   */
  const [centreLevel, setCentreLevel] = useState<ThumbLevel>('zoom')
  useEffect(() => {
    const dpr = (): number => window.devicePixelRatio || 1
    const update = (): void => setCentreLevel(centreThumbLevel(viewport, dpr()))
    update()
    // A window dragged between monitors changes DPR without resizing, so the
    // level has to follow that too. `matchMedia` is absent in jsdom and in some
    // embedded contexts; the resize path still covers the common case.
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(resolution: ${dpr()}dppx)`)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [viewport])

  // Ask for the thumbnails of whatever is on screen. Keyed on the ids alone:
  // the array identity changes on every render, which would re-request forever.
  const shownKey = shown
    .map((photo) => photo.id)
    .join(',')
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const photos = shownRef.current
    if (photos.length === 0) return
    // Two requests, not one per photo: the centre needs whatever its displayed
    // size demands, and the ring is small enough that the wall tier is ample.
    // Asking for the sharp tier for everything would decode dozens of 2560px (or
    // original) images, which is exactly the memory problem tiering exists to
    // avoid.
    const [centre, ...ring] = photos
    onShow([centre], centreLevel)
    if (ring.length > 0) onShow(ring, 'wall')
  }, [shownKey, centreLevel, onShow])

  const promote = useCallback((id: string) => {
    setState((previous) => focusPhoto(previous, id, Date.now()))
  }, [])

  /**
   * Drop the fallen cards once they are out of sight.
   *
   * They are kept in state just long enough to animate, then removed. Holding
   * them would leave a hidden pile of decoded images behind every turnover, and
   * with a 90-photo ring that is the bulk of the show's memory.
   *
   * The timer is keyed on `fallingKey`, so a second turnover cancels the first
   * clear rather than cutting the newer drop short. The delay is the animation's
   * own duration plus the longest stagger.
   */
  useEffect(() => {
    if (state.fallingKey === 0 || state.falling.length === 0) return
    const key = state.fallingKey
    const timer = window.setTimeout(() => {
      setState((previous) => showReducer(previous, { type: 'show/clearFalling', key }))
    }, FALL_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [state.fallingKey, state.falling.length])

  const setHovering = useCallback((hovering: boolean) => {
    setState((previous) => showReducer(previous, { type: 'show/hover', hovering }))
  }, [])

  const boxOf = (id: string) => state.boxes.find((box) => box.id === id)
  const paused = isPaused(state)

  return (
    <div className="random-show" ref={rootRef} role="dialog" aria-modal="true" aria-label={t('show.aria')}>
      {/*
        Ambient light behind everything. Two slow, offset glows give the layer a
        sense of depth that a flat gradient cannot: the photos appear to hang in
        a lit space rather than on a painted wall.
      */}
      <div className="random-show-glow" aria-hidden="true" />

      <div className="random-show-bar">
        {paused ? <span className="random-show-paused">{t('show.paused')}</span> : null}
        <button type="button" className="button ghost random-show-exit" onClick={onClose} title={t('show.exitHint')}>
          {t('show.exit')}
        </button>
      </div>

      {state.centre ? (
        <div
          className="random-show-centre"
          data-testid="random-centre"
          style={
            state.centreBox
              ? {
                  left: `${state.centreBox.x}px`,
                  top: `${state.centreBox.y}px`,
                  width: `${state.centreBox.w}px`,
                  height: `${state.centreBox.h}px`
                }
              : undefined
          }
        >
          {/*
            Two nested elements: the outer one is positioned and sized from the
            reducer, the inner one floats. Animating the same node that carries
            `left`/`top` would fight the transition that moves it on promotion.
          */}
          <div className="random-show-float random-show-float--centre">
            {urlMapsByLevel[centreLevel][state.centre.id] ? (
              <img
                key={state.centre.id}
                className="random-show-photo"
                src={urlMapsByLevel[centreLevel][state.centre.id]}
                alt={state.centre.name}
                draggable={false}
              />
            ) : (
              <span className="random-show-placeholder" aria-hidden="true" />
            )}
          </div>        </div>
      ) : null}

      {state.surrounding.map((photo) => {
        const box = boxOf(photo.id)
        if (!box) return null
        return (
          <button
            key={photo.id}
            type="button"
            className="random-show-thumb"
            data-testid="random-thumb"
            data-photo-id={photo.id}
            style={
              {
                left: `${box.x}px`,
                top: `${box.y}px`,
                width: `${box.w}px`,
                height: `${box.h}px`,
                // Placement order is also depth order: a photo placed later is
                // allowed to lie over an earlier one, so it has to paint on top.
                // Kept at 1 so the whole ring stays below the hover layer (3) and
                // the centre (4); anything larger would let the 90th photo cover
                // the subject.
                zIndex: 1,
                // Pose and float timing travel as custom properties: the
                // keyframes need them per element, and inline styles cannot
                // express an animation whose parameters differ per photo.
                '--pose-rotate': `${box.rotate.toFixed(2)}deg`,
                // The 3D pose: the top or bottom edge leaning away, and the card
                // turned about the vertical axis. Together with the parent's
                // `perspective` this is what makes the far edge shorter.
                '--tilt-x': `${box.tiltX.toFixed(2)}deg`,
                '--tilt-y': `${box.tiltY.toFixed(2)}deg`,
                // Pushing a distant photo back is not the same as shrinking it:
                // the perspective divides by depth, so the distortion matches
                // where the photo actually is in the scene.
                '--depth-z': `${((1 - box.depth) * -110).toFixed(1)}px`,
                // A turned card catches more light; a flat-on one catches less.
                '--sheen': `${(0.25 + Math.min(1, (Math.abs(box.tiltY) + Math.abs(box.tiltX)) / 12) * 0.55).toFixed(2)}`,
                '--float-seconds': `${box.floatSeconds.toFixed(2)}s`,
                '--float-delay': `${box.floatDelay.toFixed(2)}s`,
                // Depth drives scale, opacity and shadow together, so a photo
                // that is further back really reads as further back.
                '--depth-scale': `${(0.88 + box.depth * 0.18).toFixed(3)}`,
                '--depth-opacity': `${(0.5 + box.depth * 0.42).toFixed(3)}`,
                '--depth-blur': `${((1 - box.depth) * 1.1).toFixed(2)}px`
              } as React.CSSProperties
            }
            // Hovering a small photo pauses the show, so it can be studied
            // without the timer pulling it away.
            onPointerEnter={() => setHovering(true)}
            onPointerLeave={() => setHovering(false)}
            onClick={() => promote(photo.id)}
            title={photo.name}
          >
            {urlMapsByLevel.wall[photo.id] ? (
              <img src={urlMapsByLevel.wall[photo.id]} alt={photo.name} draggable={false} />
            ) : (
              <span className="random-show-placeholder" aria-hidden="true" />
            )}
          </button>
        )
      })}

      {/*
        The previous batch, on its way out of the window.

        Rendered above the ring but below the centre, so a falling photo can pass
        in front of the incoming batch without ever covering the subject. Each
        card carries the box it had a moment ago, so it leaves from where it was
        standing rather than snapping somewhere else first.
      */}
      {state.falling.map((card) => (
        <div
          key={card.key}
          className="random-show-falling"
          data-testid="random-falling"
          aria-hidden="true"
          style={
            {
              left: `${card.box.x}px`,
              top: `${card.box.y}px`,
              width: `${card.box.w}px`,
              height: `${card.box.h}px`,
              // The same pose it was wearing, so the fall starts from the pose
              // the eye last saw instead of from a squared-up card.
              '--pose-rotate': `${card.box.rotate.toFixed(2)}deg`,
              '--tilt-x': `${card.box.tiltX.toFixed(2)}deg`,
              '--tilt-y': `${card.box.tiltY.toFixed(2)}deg`,
              // A short, uneven stagger: dropped together but not in lockstep,
              // which is what separates a pile falling from a curtain dropping.
              '--fall-delay': `${(((card.box.x + card.box.y) % 7) * 0.028).toFixed(3)}s`,
              // The spin it picks up on the way down, sign from its own pose so
              // neighbours do not all twirl the same way.
              '--fall-spin': `${((card.box.rotate >= 0 ? 1 : -1) * (12 + (card.box.w % 9) * 3.5)).toFixed(1)}deg`
            } as React.CSSProperties
          }
        >
          {urlMapsByLevel.wall[card.photo.id] ? (
            <img src={urlMapsByLevel.wall[card.photo.id]} alt="" draggable={false} />
          ) : (
            <span className="random-show-placeholder" aria-hidden="true" />
          )}
        </div>
      ))}

      {!state.centre ? (
        <div className="random-show-empty">
          <h2>{t('show.empty')}</h2>
          <p>{t('show.emptyHint')}</p>
        </div>
      ) : null}
    </div>
  )
}
