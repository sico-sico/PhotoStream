// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/I18nProvider'
import { Scrollbar } from './Scrollbar'
import { MIN_THUMB_FRACTION } from '@shared/scrollbar'

/**
 * Pointer behaviour of the scrollbar thumb.
 *
 * These cover the two ways dragging went wrong, both from the same mistake:
 * `grabOffset` — the distance from the pointer to the thumb's top edge — must be
 * captured once, on pointerdown, and then held for the whole gesture.
 *
 * - passing half the *thumb height* as the offset for a track click made the
 *   wall scroll past the point the user aimed at;
 * - passing `0` while dragging assumed the pointer was on the thumb's top edge,
 *   so grabbing the middle of a tall thumb snapped it to the cursor first and the
 *   wall sat still until the pointer had travelled back that far.
 *
 * jsdom reports every element as 0x0, so the track's box is stubbed directly.
 */

const TRACK_TOP = 100
const TRACK_HEIGHT = 500
const VIEWPORT_HEIGHT = 500

/** 10 000 world px tall wall in a 500 px window. */
const WORLD_HEIGHT = 10_000
const SCROLLABLE = WORLD_HEIGHT - VIEWPORT_HEIGHT

/**
 * Thumb geometry, derived from the same rule the component uses.
 *
 * The visible fraction is 500/10000 = 5%, but `MIN_THUMB_FRACTION` lifts it to
 * 6% so the thumb stays grabbable. Working from the raw fraction is how the
 * first version of these tests got its expectations wrong.
 */
const THUMB_HEIGHT = TRACK_HEIGHT * MIN_THUMB_FRACTION
const TRAVEL = TRACK_HEIGHT - THUMB_HEIGHT

function stubTrackBox(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ): DOMRect {
    const isTrack = this.classList.contains('scrollbar')
    const top = isTrack ? TRACK_TOP : 0
    const height = isTrack ? TRACK_HEIGHT : 0
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 14,
      bottom: top + height,
      width: 14,
      height,
      toJSON: () => ({})
    } as DOMRect
  })
}

function renderBar(onScroll = vi.fn(), transform = { scale: 1, x: 0, y: 0 }): ReturnType<typeof render> {
  return render(
    <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
      <Scrollbar
        transform={transform}
        worldHeight={WORLD_HEIGHT}
        viewportHeight={VIEWPORT_HEIGHT}
        dateAtTop="2020-01-05"
        dateAt={() => ''}
        onScroll={onScroll}
        onPreview={() => {}}
        onScrollTarget={() => {}}
      />
    </I18nProvider>
  )
}

/** Thumb top, in viewport coordinates, for a given scroll position. */
const thumbTopFor = (y: number): number => {
  // `scrollMetrics` reports the thumb top as a fraction of the whole track.
  const scrolled = -y / SCROLLABLE
  const thumbFraction = Math.min(Math.max(scrolled, 0), 1) * (1 - MIN_THUMB_FRACTION)
  return TRACK_TOP + TRACK_HEIGHT * thumbFraction
}

/** The transform the component last asked for. */
const lastY = (onScroll: ReturnType<typeof vi.fn>): number =>
  (onScroll.mock.calls.at(-1)![0] as { y: number }).y

describe('Scrollbar pointer behaviour', () => {
  it('jumps to where the track was clicked, without overshooting', () => {
    // A track click centres the thumb on the pointer, so clicking 30% of the way
    // down the travel must land at 30% of the scroll range — not further, which
    // is what offsetting by half the thumb height used to do.
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll)

    const bar = screen.getByRole('scrollbar')
    const clickY = TRACK_TOP + TRAVEL * 0.3 + THUMB_HEIGHT / 2
    fireEvent.pointerDown(bar, { button: 0, clientY: clickY, pointerId: 1 })

    expect(onScroll).toHaveBeenCalledTimes(1)
    expect(lastY(onScroll)).toBeCloseTo(-SCROLLABLE * 0.3, 0)
  })

  it('does not move when the thumb is clicked where it already sits', () => {
    // A click inside the thumb is a grab, not a jump.
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll, { scale: 1, x: 0, y: -4000 })

    const bar = screen.getByRole('scrollbar')
    fireEvent.pointerDown(bar, { button: 0, clientY: thumbTopFor(-4000) + THUMB_HEIGHT / 2, pointerId: 1 })

    expect(lastY(onScroll)).toBeCloseTo(-4000, 0)
  })

  it('moves the thumb one-for-one with the pointer, wherever it was grabbed', () => {
    // Grabbing near the bottom of the thumb and moving 50px down must scroll 50px
    // of track. Passing `0` snapped the thumb to the cursor first, which is what
    // made a drag feel stuck until the pointer had travelled back.
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll, { scale: 1, x: 0, y: -4000 })

    const bar = screen.getByRole('scrollbar')
    const grabY = thumbTopFor(-4000) + THUMB_HEIGHT * 0.8
    fireEvent.pointerDown(bar, { button: 0, clientY: grabY, pointerId: 1 })

    const before = lastY(onScroll)
    fireEvent.pointerMove(bar, { clientY: grabY + 50, pointerId: 1 })
    const after = lastY(onScroll)

    expect(after - before).toBeCloseTo(-(50 / TRAVEL) * SCROLLABLE, 0)
  })

  it('holds the grab offset across several pointer moves', () => {
    // Recomputing the offset per move would make the thumb drift away from the
    // cursor in proportion to how far it had been dragged.
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll, { scale: 1, x: 0, y: -4000 })

    const bar = screen.getByRole('scrollbar')
    const grabY = thumbTopFor(-4000) + THUMB_HEIGHT * 0.5
    fireEvent.pointerDown(bar, { button: 0, clientY: grabY, pointerId: 1 })

    const initial = lastY(onScroll)
    for (const step of [20, 40, 60]) {
      fireEvent.pointerMove(bar, { clientY: grabY + step, pointerId: 1 })
    }

    // 60px in three hops must equal 60px in one hop.
    expect(lastY(onScroll) - initial).toBeCloseTo(-(60 / TRAVEL) * SCROLLABLE, 0)
  })

  it('clamps at the top when dragged above the track', () => {
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll, { scale: 1, x: 0, y: -4000 })

    const bar = screen.getByRole('scrollbar')
    fireEvent.pointerDown(bar, { button: 0, clientY: TRACK_TOP + 100, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientY: TRACK_TOP - 400, pointerId: 1 })

    expect(lastY(onScroll)).toBeCloseTo(0, 6)
  })

  it('clamps at the bottom when dragged below the track', () => {
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll, { scale: 1, x: 0, y: -4000 })

    const bar = screen.getByRole('scrollbar')
    fireEvent.pointerDown(bar, { button: 0, clientY: TRACK_TOP + 100, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientY: TRACK_TOP + TRACK_HEIGHT + 400, pointerId: 1 })

    expect(lastY(onScroll)).toBeCloseTo(-SCROLLABLE, 0)
  })

  it('ignores pointer moves before the drag has started', () => {
    stubTrackBox()
    const onScroll = vi.fn()
    renderBar(onScroll)

    const bar = screen.getByRole('scrollbar')
    fireEvent.pointerMove(bar, { clientY: TRACK_TOP + 200, pointerId: 1 })
    expect(onScroll).not.toHaveBeenCalled()
  })
})
