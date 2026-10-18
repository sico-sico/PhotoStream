// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import { usePanZoom } from './usePanZoom'
import type { Transform } from '@shared/transform'

/**
 * The hook is the only place that bridges DOM pointer events to the pure
 * transform maths, so it needs exercising against real events.
 *
 * `setTransform` is captured by hand rather than going through React state:
 * that lets each assertion read the exact transform the hook produced, without
 * waiting for a re-render.
 */

let latest: Transform = { scale: 1, x: 0, y: 0 }
/** Every transform the hook pushed to the DOM during a gesture. */
let live: Transform[] = []
/** How many times the hook asked React to re-render. */
let commits = 0

function Harness({
  onItemClick,
  onBackgroundClick,
  wheelOn
}: {
  onItemClick: (id: string) => void
  onBackgroundClick?: () => void
  wheelOn?: 'element' | 'window'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const setTransform = (updater: (previous: Transform) => Transform): void => {
    commits += 1
    latest = updater(latest)
  }
  const handlers = usePanZoom(setTransform, {
    onItemClick,
    onBackgroundClick,
    wheelTarget: wheelOn === 'element' ? ref.current : null,
    onLiveTransform: (transform) => live.push(transform),
    getTransform: () => latest
  })

  return (
    <div ref={ref} data-testid="stage" style={{ width: '800px', height: '600px' }} {...handlers}>
      <div data-photo-id="photo-a" data-testid="tile">
        tile
      </div>
      <div data-testid="background" />
    </div>
  )
}

/** Dispatch a pointer event with the fields the hook reads. */
function pointer(element: Element, type: string, init: PointerEventInit): void {
  element.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init })
  )
}

/**
 * jsdom does not implement pointer capture, and the hook calls it defensively.
 * Providing the methods keeps the real code path intact.
 */
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

afterEach(() => {
  cleanup()
  latest = { scale: 1, x: 0, y: 0 }
  live = []
  commits = 0
})

describe('usePanZoom', () => {
  describe('panning', () => {
    it('moves the wall by the pointer delta', () => {
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 100, clientY: 100, button: 0 })
      pointer(stage, 'pointermove', { clientX: 140, clientY: 130 })
      pointer(stage, 'pointerup', { clientX: 140, clientY: 130 })

      expect(latest).toEqual({ scale: 1, x: 40, y: 30 })
    })

    it('accumulates multiple moves into the transform committed on release', () => {
      // State is only written once, when the gesture ends: routing every frame
      // through React re-rendered 3226 tiles and cost 27 ms per frame.
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0 })
      pointer(stage, 'pointermove', { clientX: 10, clientY: 0 })
      pointer(stage, 'pointermove', { clientX: 10, clientY: 25 })
      pointer(stage, 'pointermove', { clientX: 30, clientY: 25 })
      pointer(stage, 'pointerup', { clientX: 30, clientY: 25 })

      expect(latest).toEqual({ scale: 1, x: 30, y: 25 })
    })

    it('reports every frame to the live callback without touching state', () => {
      live = []
      commits = 0
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0 })
      pointer(stage, 'pointermove', { clientX: 10, clientY: 0 })
      pointer(stage, 'pointermove', { clientX: 25, clientY: 5 })

      // The DOM has followed the pointer the whole way...
      expect(live).toEqual([
        { scale: 1, x: 10, y: 0 },
        { scale: 1, x: 25, y: 5 }
      ])
      // ...while React has not been asked to render even once.
      expect(commits).toBe(0)

      pointer(stage, 'pointerup', { clientX: 25, clientY: 5 })
      expect(commits).toBe(1)
      expect(latest).toEqual({ scale: 1, x: 25, y: 5 })
    })

    it('does not pan on a right click', () => {
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 2 })
      pointer(stage, 'pointermove', { clientX: 100, clientY: 100 })

      expect(latest).toEqual({ scale: 1, x: 0, y: 0 })
    })

    it('ignores a move after the gesture ended', () => {
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0 })
      pointer(stage, 'pointerup', { clientX: 0, clientY: 0 })
      pointer(stage, 'pointermove', { clientX: 50, clientY: 50 })

      expect(latest).toEqual({ scale: 1, x: 0, y: 0 })
    })

    it('ignores a second pointer id mid-gesture', () => {
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 1 })
      pointer(stage, 'pointermove', { clientX: 99, clientY: 99, pointerId: 2 })

      expect(latest).toEqual({ scale: 1, x: 0, y: 0 })
    })

    it('abandons the gesture on pointer cancel', () => {
      render(<Harness onItemClick={() => {}} />)
      const stage = document.querySelector('[data-testid="stage"]')!

      pointer(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0 })
      pointer(stage, 'pointercancel', { clientX: 0, clientY: 0 })
      pointer(stage, 'pointermove', { clientX: 50, clientY: 50 })

      expect(latest).toEqual({ scale: 1, x: 0, y: 0 })
    })
  })

  describe('click versus drag', () => {
    it('opens the clicked photo', () => {
      const onItemClick = vi.fn()
      render(<Harness onItemClick={onItemClick} />)
      const tile = document.querySelector('[data-photo-id]')!

      pointer(tile, 'pointerdown', { clientX: 50, clientY: 50, button: 0 })
      pointer(tile, 'pointerup', { clientX: 51, clientY: 50 })

      expect(onItemClick).toHaveBeenCalledWith('photo-a')
    })

    it('does not open a photo after a drag', () => {
      const onItemClick = vi.fn()
      render(<Harness onItemClick={onItemClick} />)
      const tile = document.querySelector('[data-photo-id]')!

      pointer(tile, 'pointerdown', { clientX: 50, clientY: 50, button: 0 })
      pointer(tile, 'pointermove', { clientX: 200, clientY: 200 })
      pointer(tile, 'pointerup', { clientX: 200, clientY: 200 })

      expect(onItemClick).not.toHaveBeenCalled()
    })

    it('reports a background click separately', () => {
      const onItemClick = vi.fn()
      const onBackgroundClick = vi.fn()
      render(<Harness onItemClick={onItemClick} onBackgroundClick={onBackgroundClick} />)
      const background = document.querySelector('[data-testid="background"]')!

      pointer(background, 'pointerdown', { clientX: 10, clientY: 10, button: 0 })
      pointer(background, 'pointerup', { clientX: 10, clientY: 10 })

      expect(onBackgroundClick).toHaveBeenCalledTimes(1)
      expect(onItemClick).not.toHaveBeenCalled()
    })

    it('tolerates a few pixels of jitter inside a tile', () => {
      const onItemClick = vi.fn()
      render(<Harness onItemClick={onItemClick} />)
      const tile = document.querySelector('[data-photo-id]')!

      pointer(tile, 'pointerdown', { clientX: 50, clientY: 50, button: 0 })
      pointer(tile, 'pointerup', { clientX: 54, clientY: 53 })

      expect(onItemClick).toHaveBeenCalledWith('photo-a')
    })
  })

  describe('wheel zoom', () => {
    it('zooms in on wheel up', () => {
      render(<Harness onItemClick={() => {}} />)

      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 300, clientY: 200, cancelable: true }))
      expect(latest.scale).toBeGreaterThan(1)
    })

    it('zooms out on wheel down', () => {
      render(<Harness onItemClick={() => {}} />)

      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, clientX: 300, clientY: 200, cancelable: true }))
      expect(latest.scale).toBeLessThan(1)
    })

    it('prevents the default action so the page cannot scroll', () => {
      render(<Harness onItemClick={() => {}} />)

      const event = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    })

    it('keeps the cursor anchor while zooming', () => {
      latest = { scale: 1, x: 0, y: 0 }
      render(<Harness onItemClick={() => {}} />)

      const cursor = { x: 400, y: 300 }
      const worldBefore = { x: (cursor.x - latest.x) / latest.scale, y: (cursor.y - latest.y) / latest.scale }

      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: cursor.x, clientY: cursor.y, cancelable: true }))

      const worldAfter = { x: (cursor.x - latest.x) / latest.scale, y: (cursor.y - latest.y) / latest.scale }
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6)
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6)
    })

    it('stops listening after unmount', () => {
      const { unmount } = render(<Harness onItemClick={() => {}} />)
      unmount()

      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 0, clientY: 0, cancelable: true }))
      expect(latest).toEqual({ scale: 1, x: 0, y: 0 })
    })
  })
})
