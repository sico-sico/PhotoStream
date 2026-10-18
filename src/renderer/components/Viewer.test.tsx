// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { Viewer } from './Viewer'

const photo: Photo = {
  id: 'p1',
  path: '/photos/kyoto.jpg',
  name: 'kyoto.jpg',
  width: 6000,
  height: 4000,
  takenAt: '2019-07-14',
  dateSource: 'exif',
  mtimeMs: 0,
  sizeBytes: 0
}

/**
 * Stand-in for the preload bridge.
 *
 * Only the EXIF read is needed here; the viewer otherwise talks to the protocol
 * and to its props. It is stubbed rather than run for real because jsdom has no
 * Node bridge.
 */
const photoExif = vi.fn(async () => ({ make: 'SONY', model: 'ILCE-7M5', fNumber: 1.8 }))
beforeEach(() => {
  photoExif.mockClear()
  Object.defineProperty(window, 'photoStream', {
    configurable: true,
    value: { photoExif }
  })
})

/**
 * Render the viewer with the panel state it now expects from its owner.
 *
 * `infoOpen` is controlled rather than internal, because the choice has to be
 * remembered across photos and persisted; a test that passed a fixed prop would
 * never see the panel toggle. This wrapper is the smallest owner that behaves
 * like the wall does.
 */
function renderViewer(
  props: Partial<React.ComponentProps<typeof Viewer>> = {},
  locale = 'en'
): ReturnType<typeof render> & { infoChanges: boolean[] } {
  const infoChanges: boolean[] = []
  function Harness(): React.JSX.Element {
    const [open, setOpen] = React.useState(props.infoOpen ?? false)
    return (
      <Viewer
        photo={photo}
        previewUrl="pic://thumb/hash-wall.webp"
        onClose={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
        onReveal={() => {}}
        {...props}
        infoOpen={open}
        onInfoOpenChange={(next) => {
          infoChanges.push(next)
          setOpen(next)
          props.onInfoOpenChange?.(next)
        }}
      />
    )
  }
  const result = render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <Harness />
    </I18nProvider>
  )
  return { ...result, infoChanges }
}

describe('Viewer', () => {
  it('shows the file name and dimensions', () => {
    renderViewer()
    expect(screen.getByText('kyoto.jpg')).toBeInTheDocument()
    expect(screen.getByText(/6000×4000/)).toBeInTheDocument()
  })

  it('renders the cached preview immediately and the original alongside it', () => {
    renderViewer()
    const preview = document.querySelector('img.preview')
    const full = document.querySelector('img:not(.preview)')

    expect(preview).toHaveAttribute('src', 'pic://thumb/hash-wall.webp')
    // The full-resolution image streams through the custom protocol.
    expect(full?.getAttribute('src')).toContain('pic://photo/')
    expect(full?.getAttribute('src')).toContain('kyoto.jpg')
  })

  it('hides the preview once the original has loaded', async () => {
    renderViewer()
    const full = document.querySelector('img:not(.preview)') as HTMLImageElement

    expect(full.className).not.toContain('ready')
    full.dispatchEvent(new Event('load'))
    await screen.findByText('kyoto.jpg')

    expect(document.querySelector('img.preview')?.className).toContain('hidden')
    expect(full.className).toContain('ready')
  })

  it('closes on Escape, steps on arrow keys', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onPrev = vi.fn()
    const onNext = vi.fn()
    renderViewer({ onClose, onPrev, onNext })

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{ArrowLeft}')
    expect(onPrev).toHaveBeenCalledTimes(1)

    await user.keyboard('{ArrowRight}')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('stops listening after unmount', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { unmount } = renderViewer({ onClose })

    unmount()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on a click anywhere in the stage', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderViewer({ onClose })

    await user.click(screen.getByTestId('viewer-stage'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when the gesture was a drag', async () => {
    // Panning a zoomed photo must never be mistaken for "click to dismiss".
    const onClose = vi.fn()
    renderViewer({ onClose })

    const stage = screen.getByTestId('viewer-stage')
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100, clientY: 100 }))
    stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 240, clientY: 220 }))
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 240, clientY: 220 }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('rotates a quarter turn per click and shows the angle', async () => {
    const user = userEvent.setup()
    renderViewer()

    const image = screen.getByTestId('viewer-image')
    expect(image.style.transform).toBe('')

    await user.click(screen.getByRole('button', { name: /rotate right/i }))
    expect(screen.getByTestId('viewer-image').style.transform).toBe('rotate(90deg)')
    expect(screen.getByText(/90°/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /rotate right/i }))
    await user.click(screen.getByRole('button', { name: /rotate right/i }))
    await user.click(screen.getByRole('button', { name: /rotate right/i }))
    // Four quarter turns come back to upright, not to 360deg.
    expect(screen.getByTestId('viewer-image').style.transform).toBe('')
    expect(screen.queryByText(/°/)).toBeNull()
  })

  it('rotates the other way', async () => {
    const user = userEvent.setup()
    renderViewer()

    await user.click(screen.getByRole('button', { name: /rotate left/i }))
    expect(screen.getByTestId('viewer-image').style.transform).toBe('rotate(-90deg)')
  })

  it('rotates with the keyboard and resets with 0', async () => {
    const user = userEvent.setup()
    renderViewer()

    await user.keyboard('r')
    expect(screen.getByTestId('viewer-image').style.transform).toBe('rotate(90deg)')

    await user.keyboard('{0}')
    expect(screen.getByTestId('viewer-image').style.transform).toBe('')
  })

  it('resets rotation whenever the photo changes', async () => {
    // A rotation belongs to the photo it was applied to; inheriting it would
    // show the next photo sideways for no stated reason.
    const user = userEvent.setup()
    const { rerender } = renderViewer()

    await user.click(screen.getByRole('button', { name: /rotate right/i }))
    expect(screen.getByTestId('viewer-image').style.transform).toBe('rotate(90deg)')

    rerender(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <Viewer
          photo={{ ...photo, id: 'p2', name: 'paris.jpg' }}
          previewUrl={undefined}
          onClose={() => {}}
          onPrev={() => {}}
          onNext={() => {}}
          onReveal={() => {}}
        />
      </I18nProvider>
    )

    expect(screen.getByTestId('viewer-image').style.transform).toBe('')
  })

  it('does not close the viewer when a second finger arrives', () => {
    // The second pointer cancels the pan; treating its release as a click would
    // dismiss the photo in the middle of a pinch.
    const onClose = vi.fn()
    renderViewer({ onClose })
    const stage = screen.getByTestId('viewer-stage')

    const pointer = (type: string, id: number, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: x, clientY: y })

    stage.dispatchEvent(pointer('pointerdown', 1, 400, 400))
    stage.dispatchEvent(pointer('pointerdown', 2, 600, 400))
    stage.dispatchEvent(pointer('pointermove', 2, 700, 400))
    stage.dispatchEvent(pointer('pointerup', 2, 700, 400))
    stage.dispatchEvent(pointer('pointerup', 1, 400, 400))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('marks the stage as pinching while two fingers are down', () => {
    renderViewer()
    const stage = screen.getByTestId('viewer-stage')
    const pointer = (type: string, id: number, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: x, clientY: y })

    act(() => {
      stage.dispatchEvent(pointer('pointerdown', 1, 400, 400))
    })
    expect(screen.getByTestId('viewer-stage').className).not.toContain('pinching')

    act(() => {
      stage.dispatchEvent(pointer('pointerdown', 2, 600, 400))
    })
    expect(screen.getByTestId('viewer-stage').className).toContain('pinching')

    act(() => {
      stage.dispatchEvent(pointer('pointerup', 2, 600, 400))
    })
    expect(screen.getByTestId('viewer-stage').className).not.toContain('pinching')
  })

  /**
   * jsdom reports every element as 0x0 and never decodes an image, so the viewer
   * would refuse to zoom (there is nothing to clamp against). These tests stub
   * the stage measurement and the `naturalWidth`/`naturalHeight` pair that a real
   * decode would provide.
   */
  describe('with a measured stage', () => {
    const originalRect = Element.prototype.getBoundingClientRect

    beforeEach(() => {
      Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
        return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
    })

    afterEach(() => {
      Element.prototype.getBoundingClientRect = originalRect
    })

    /**
     * Load the photo at a given intrinsic size.
     *
     * `naturalWidth` is a read-only accessor on a real `<img>`, but jsdom's
     * images never decode, so it is defined per-element for the test.
     */
    const loadPhoto = (naturalWidth: number, naturalHeight: number): HTMLImageElement => {
      const image = screen.getByTestId('viewer-image') as HTMLImageElement
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: naturalWidth })
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: naturalHeight })
      act(() => {
        image.dispatchEvent(new Event('load'))
      })
      return image
    }

    const scaleOf = (): number => {
      const style = screen.getByTestId('viewer-image').style.transform
      const match = /scale\(([\d.]+)\)/.exec(style)
      return match ? Number(match[1]) : 1
    }

    it('sizes the photo from its ratio, not from the element box', () => {
      // 3:2 into a 1000x800 stage is limited by width, so the photo ends up
      // 1000x667 even though the element box would happily be 1000x800.
      renderViewer()
      const image = loadPhoto(3000, 2000)
      expect(image.style.width).toBe('1000px')
      expect(parseFloat(image.style.height)).toBeCloseTo(666.67, 1)
    })

    it('shrinks a rotated photo so it still fits the stage', () => {
      // 3:2 fitted at 1000x667. Turned upright it is 667 wide and 1000 tall,
      // which overflows an 800px-tall stage, so it must be scaled to 0.8.
      const user = userEvent.setup()
      renderViewer()
      loadPhoto(3000, 2000)

      act(() => {
        screen.getByRole('button', { name: /rotate right/i }).click()
      })
      void user

      const style = screen.getByTestId('viewer-image').style.transform
      expect(style).toContain('rotate(90deg)')
      expect(scaleOf()).toBeCloseTo(0.8, 2)
    })

    it('keeps a photo that still fits at full size when rotated', () => {
      // 1:1 (1000x1000 into a 1000x800 stage) is limited by height, so rotating
      // it leaves the box unchanged and must not shrink it at all.
      renderViewer()
      loadPhoto(1000, 1000)
      act(() => {
        screen.getByRole('button', { name: /rotate right/i }).click()
      })
      expect(scaleOf()).toBe(1)
    })

    it('does not let the wheel reach the wall behind the overlay', () => {
      // The wall zooms on window-level wheel events. Without stopPropagation the
      // photo behind the viewer zoomed too, so closing the viewer landed on a
      // wall scrolled far from where the user left it.
      renderViewer()
      loadPhotoSeed()
      const leaked: EventTarget[] = []
      const onWindowWheel = (event: Event): void => {
        leaked.push(event.target as EventTarget)
      }
      window.addEventListener('wheel', onWindowWheel)

      const stage = screen.getByTestId('viewer-stage')
      act(() => {
        stage.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, clientX: 500, clientY: 400, bubbles: true, cancelable: true })
        )
      })

      window.removeEventListener('wheel', onWindowWheel)
      expect(leaked).toHaveLength(0)
      expect(scaleOf()).toBeGreaterThan(1)
    })

    it('zooms in and out with the wheel', () => {
      renderViewer()
      loadPhotoSeed()
      const stage = screen.getByTestId('viewer-stage')
      const wheel = (deltaY: number): void => {
        act(() => {
          stage.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: 500, clientY: 400, bubbles: true, cancelable: true }))
        })
      }

      expect(scaleOf()).toBe(1)
      wheel(-100)
      expect(scaleOf()).toBeGreaterThan(1)
      const zoomedIn = scaleOf()
      wheel(100)
      expect(scaleOf()).toBeLessThan(zoomedIn)
    })

    it('anchors the wheel zoom on the cursor', () => {
      // Zooming at the left edge must push the photo right, so the point under
      // the cursor stays put; zooming at the centre never moves it.
      renderViewer()
      loadPhotoSeed()
      const stage = screen.getByTestId('viewer-stage')
      act(() => {
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 0, clientY: 400, bubbles: true, cancelable: true }))
      })
      const transform = screen.getByTestId('viewer-image').style.transform
      const x = Number(/translate\((-?[\d.]+)px/.exec(transform)?.[1] ?? 0)
      // The cursor sits 500px left of centre, so the photo moves right.
      expect(x).toBeGreaterThan(0)
    })

    it('zooms with the +/- keys', async () => {
      const user = userEvent.setup()
      renderViewer()
      loadPhotoSeed()

      await user.keyboard('+')
      expect(scaleOf()).toBeGreaterThan(1)

      const zoomedIn = scaleOf()
      await user.keyboard('-')
      expect(scaleOf()).toBeLessThan(zoomedIn)
    })

    it('pinches to zoom, anchored between the fingers', () => {
      renderViewer()
      loadPhotoSeed()
      const stage = screen.getByTestId('viewer-stage')
      const pointer = (type: string, id: number, x: number, y: number): PointerEvent =>
        new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: x, clientY: y })

      act(() => {
        stage.dispatchEvent(pointer('pointerdown', 1, 400, 400))
        stage.dispatchEvent(pointer('pointerdown', 2, 600, 400))
      })
      // Spread the fingers from 200px to 500px apart: 2.5x the starting spread.
      act(() => {
        stage.dispatchEvent(pointer('pointermove', 2, 900, 400))
      })

      expect(scaleOf()).toBeCloseTo(2.5, 1)
    })

    it('cancels the pan when a second finger lands mid-drag', () => {
      // Reading the second pointer as a drag would teleport the photo by the
      // distance between the two fingers.
      renderViewer()
      loadPhotoSeed()
      const stage = screen.getByTestId('viewer-stage')
      const pointer = (type: string, id: number, x: number, y: number): PointerEvent =>
        new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: x, clientY: y })

      act(() => {
        stage.dispatchEvent(pointer('pointerdown', 1, 400, 400))
        stage.dispatchEvent(pointer('pointerdown', 2, 800, 400))
      })
      act(() => {
        stage.dispatchEvent(pointer('pointerup', 2, 800, 400))
        stage.dispatchEvent(pointer('pointerup', 1, 400, 400))
      })

      expect(screen.getByTestId('viewer-image').style.transform).toBe('')
    })

    /** Give the photo a known intrinsic size, synchronously enough for renders. */
    function loadPhotoSeed(): void {
      const image = screen.getByTestId('viewer-image') as HTMLImageElement
      act(() => {
        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 4000 })
        Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 3200 })
        image.dispatchEvent(new Event('load'))
      })
    }
  })

  it('wires the toolbar buttons', async () => {
    const user = userEvent.setup()
    const onPrev = vi.fn()
    const onNext = vi.fn()
    const onClose = vi.fn()
    const onReveal = vi.fn()
    renderViewer({ onPrev, onNext, onClose, onReveal })

    await user.click(screen.getByRole('button', { name: /previous photo/i }))
    await user.click(screen.getByRole('button', { name: /next photo/i }))
    await user.click(screen.getByRole('button', { name: /close viewer/i }))
    await user.click(screen.getByRole('button', { name: /show in folder/i }))

    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('is announced as a modal dialog named after the photo', () => {
    renderViewer()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('kyoto.jpg')
  })

  describe('details panel', () => {
    it('reads the EXIF only when the panel is opened', async () => {
      // The read costs a metadata parse, so it must not happen on every open of
      // the viewer — only when someone asks to see the details.
      const user = userEvent.setup()
      renderViewer()
      expect(photoExif).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: /details/i }))
      expect(photoExif).toHaveBeenCalledWith('/photos/kyoto.jpg')
    })

    it('shows the values once they arrive', async () => {
      const user = userEvent.setup()
      renderViewer()
      await user.click(screen.getByRole('button', { name: /details/i }))

      expect(await screen.findByTestId('info-panel')).toBeInTheDocument()
      expect(await screen.findByText('SONY ILCE-7M5')).toBeInTheDocument()
      expect(screen.getByText('f/1.8')).toBeInTheDocument()
    })

    it('toggles with the I key', async () => {
      const user = userEvent.setup()
      renderViewer()

      await user.keyboard('i')
      expect(await screen.findByTestId('info-panel')).toBeInTheDocument()

      await user.keyboard('i')
      expect(screen.queryByTestId('info-panel')).toBeNull()
    })

    it('closes from the panel own button', async () => {
      const user = userEvent.setup()
      renderViewer()
      await user.click(screen.getByRole('button', { name: /details/i }))
      const panel = await screen.findByTestId('info-panel')

      // Both the toolbar toggle and the panel's own close button use the same
      // label once the panel is open, so the query is scoped to the panel.
      await user.click(within(panel).getByRole('button', { name: /hide details/i }))
      expect(screen.queryByTestId('info-panel')).toBeNull()
    })

    it('re-reads when stepping to another photo', async () => {
      // Otherwise the panel would keep describing the previous photo.
      const user = userEvent.setup()
      const { rerender } = renderViewer()
      await user.click(screen.getByRole('button', { name: /details/i }))
      await screen.findByTestId('info-panel')
      expect(photoExif).toHaveBeenCalledTimes(1)

      rerender(
        <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
          <Viewer
            photo={{ ...photo, id: 'p2', path: '/photos/paris.jpg', name: 'paris.jpg' }}
            previewUrl={undefined}
            onClose={() => {}}
            onPrev={() => {}}
            onNext={() => {}}
            onReveal={() => {}}
            // The panel state now comes from the owner, and it stays open: that
            // is the whole point of remembering the choice.
            infoOpen
            onInfoOpenChange={() => {}}
          />
        </I18nProvider>
      )

      expect(photoExif).toHaveBeenCalledWith('/photos/paris.jpg')
      expect(photoExif).toHaveBeenCalledTimes(2)
    })

    it('marks the toggle as expanded', async () => {
      const user = userEvent.setup()
      renderViewer()
      const toggle = screen.getByRole('button', { name: /details/i })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')

      await user.click(toggle)
      // The toolbar toggle keeps its identity and now reports the open state.
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    it('starts expanded when the preference says so', async () => {
      // Dropping a picture, or Explorer's "Open with", turns the preference on:
      // its details are part of what was asked for.
      renderViewer({ infoOpen: true })

      expect(await screen.findByTestId('info-panel')).toBeInTheDocument()
      expect(photoExif).toHaveBeenCalledWith('/photos/kyoto.jpg')
    })

    it('starts collapsed when the preference is off', async () => {
      renderViewer({ infoOpen: false })
      expect(screen.queryByTestId('info-panel')).toBeNull()
      expect(photoExif).not.toHaveBeenCalled()
    })

    it('reports every toggle so the choice can be remembered', async () => {
      // The state lives with the wall, not here: without this callback the
      // preference could not be persisted and the panel would close again on the
      // next photo.
      const user = userEvent.setup()
      const { infoChanges } = renderViewer()

      await user.keyboard('i')
      await screen.findByTestId('info-panel')
      await user.keyboard('i')
      expect(screen.queryByTestId('info-panel')).toBeNull()

      expect(infoChanges).toEqual([true, false])
    })

    it('keeps the panel open across a photo change', async () => {
      // The reported bug: stepping to the next photo closed the panel, even
      // though the user had deliberately opened it.
      const user = userEvent.setup()
      const { rerender } = renderViewer()
      await user.keyboard('i')
      await screen.findByTestId('info-panel')

      rerender(
        <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
          <Viewer
            photo={{ ...photo, id: 'p2', path: '/photos/paris.jpg', name: 'paris.jpg' }}
            previewUrl={undefined}
            onClose={() => {}}
            onPrev={() => {}}
            onNext={() => {}}
            onReveal={() => {}}
            infoOpen
            onInfoOpenChange={() => {}}
          />
        </I18nProvider>
      )

      expect(await screen.findByTestId('info-panel')).toBeInTheDocument()
      expect(photoExif).toHaveBeenCalledWith('/photos/paris.jpg')
    })
  })

  it('localises the interface', () => {
    renderViewer({}, 'zh-CN')
    expect(screen.getByRole('button', { name: '上一张' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭查看' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeInTheDocument()
  })

  it('reports a missing capture date instead of showing a blank', () => {
    renderViewer({ photo: { ...photo, takenAt: '', dateSource: 'none' } }, 'fr')
    expect(screen.getByText(/aucune date de prise de vue/)).toBeInTheDocument()
  })

  it('omits the dimensions when they are unknown', () => {
    renderViewer({ photo: { ...photo, width: 0, height: 0 } })
    expect(screen.queryByText(/×/)).toBeNull()
  })

  it('resets the preview when switching photos', async () => {
    const { rerender } = renderViewer()
    const full = document.querySelector('img:not(.preview)') as HTMLImageElement
    full.dispatchEvent(new Event('load'))
    await screen.findByText('kyoto.jpg')
    expect(full.className).toContain('ready')

    rerender(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <Viewer
          photo={{ ...photo, id: 'p2', name: 'paris.jpg' }}
          previewUrl="pic://thumb/other-wall.webp"
          onClose={() => {}}
          onPrev={() => {}}
          onNext={() => {}}
          onReveal={() => {}}
        />
      </I18nProvider>
    )

    const next = document.querySelector('img:not(.preview)') as HTMLImageElement
    // The new photo must not inherit the previous photo's "loaded" state, or the
    // thumbnail would be hidden before the original arrives.
    expect(next.className).not.toContain('ready')
  })
})
