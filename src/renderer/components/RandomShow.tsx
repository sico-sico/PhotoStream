import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '@shared/types'
import { useI18n } from '../i18n/context'
import { INITIAL_SHOW_STATE, advance, focusPhoto, isPaused, shownPhotos, showReducer } from '../state/randomShow'

export interface RandomShowProps {
  /** Photos the show may draw from — the caller passes the filtered set. */
  pool: readonly Photo[]
  /** Thumbnail URLs by photo id, as the wall already has them. */
  thumbUrls: Record<string, string>
  /** Called when the on-screen set changes, so the caller can request thumbnails. */
  onShow: (photos: readonly Photo[]) => void
  onClose: () => void
}

/** How long a photo stays centred before a neighbour takes over. */
export const PHOTO_INTERVAL_MS = 8000

/** How long a ring lasts before a fresh set is drawn. */
export const BATCH_INTERVAL_MS = 60000

/** Timer resolution. Fine enough for an 8 s interval, cheap enough to idle on. */
const TICK_MS = 250

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
export function RandomShow({ pool, thumbUrls, onShow, onClose }: RandomShowProps): React.JSX.Element {
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
      if (rect.width > 0 && rect.height > 0) {
        setViewport({ width: Math.round(rect.width), height: Math.round(rect.height) })
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Start once the window has been measured. Re-seeded per visit, so two visits
  // show different photos; the seed is kept in the state so a resize can
  // reproduce the same ring.
  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0 || pool.length === 0) return
    setState((previous) =>
      showReducer(previous, {
        type: 'show/start',
        pool,
        viewport,
        seed: (Date.now() & 0x7fffffff) >>> 0
      })
    )
  }, [pool, viewport])

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
        advance(previous, { now: Date.now(), photoMs: PHOTO_INTERVAL_MS, batchMs: BATCH_INTERVAL_MS })
      )
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

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

  // Ask for the thumbnails of whatever is on screen. Keyed on the ids alone:
  // the array identity changes on every render, which would re-request forever.
  const shownKey = shown
    .map((photo) => photo.id)
    .join(',')
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    if (shownRef.current.length > 0) onShow(shownRef.current)
  }, [shownKey, onShow])

  const promote = useCallback((id: string) => {
    setState((previous) => focusPhoto(previous, id, Date.now()))
  }, [])

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
        <span className="random-show-count">
          {t('show.counter', { shown: shown.length, total: state.pool.length })}
        </span>
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
            {thumbUrls[state.centre.id] ? (
              <img
                key={state.centre.id}
                className="random-show-photo"
                src={thumbUrls[state.centre.id]}
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
            {thumbUrls[photo.id] ? (
              <img src={thumbUrls[photo.id]} alt={photo.name} draggable={false} />
            ) : (
              <span className="random-show-placeholder" aria-hidden="true" />
            )}
          </button>
        )
      })}

      {!state.centre ? (
        <div className="random-show-empty">
          <h2>{t('show.empty')}</h2>
          <p>{t('show.emptyHint')}</p>
        </div>
      ) : null}
    </div>
  )
}
