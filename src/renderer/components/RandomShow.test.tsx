// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { RandomShow, PHOTO_INTERVAL_MS } from './RandomShow'

/**
 * The random show component.
 *
 * The timing and geometry are covered by `state/randomShow.test.ts` and
 * `shared/random.test.ts`; what is left here is the wiring that cannot be tested
 * there — that the overlay renders the computed boxes, that hovering pauses, that
 * a click promotes, and that Escape closes.
 */

function photo(index: number): Photo {
  return {
    id: `p${index}`,
    path: `/photos/p${index}.jpg`,
    name: `p${index}.jpg`,
    width: 6000,
    height: 4000,
    takenAt: '2020-01-01',
    dateSource: 'exif',
    mtimeMs: 0,
    sizeBytes: 0
  }
}

const POOL = Array.from({ length: 30 }, (_, i) => photo(i))

/** jsdom reports every element as 0x0, so the overlay is given a real box. */
function stubSize(width = 1600, height = 956): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isRoot = this.classList.contains('random-show')
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: isRoot ? width : 0,
      bottom: isRoot ? height : 0,
      width: isRoot ? width : 0,
      height: isRoot ? height : 0,
      toJSON: () => ({})
    } as DOMRect
  })
}

/** URLs at every tier, so the centre can be served at whatever its size demands. */
const wallUrls = Object.fromEntries(POOL.map((p) => [p.id, `pic://thumb/${p.id}-wall.webp`]))
const zoomUrls = Object.fromEntries(POOL.map((p) => [p.id, `pic://thumb/${p.id}-zoom.webp`]))
const fullUrls = Object.fromEntries(POOL.map((p) => [p.id, `pic://photo/${p.id}.jpg`]))
const urlMapsByLevel = { wall: wallUrls, zoom: zoomUrls, full: fullUrls }

function renderShow(props: Partial<React.ComponentProps<typeof RandomShow>> = {}) {
  return render(
    <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
      <RandomShow
        pool={POOL}
        urlMapsByLevel={urlMapsByLevel}
        onShow={() => {}}
        onClose={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

beforeEach(() => {
  stubSize()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RandomShow', () => {
  it('shows one large photo and a ring of smaller ones', async () => {
    renderShow()

    const centre = await screen.findByTestId('random-centre')
    expect(centre).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(0))
  })

  it('sizes the centre photo to about two thirds of the window', async () => {
    renderShow()
    const centre = await screen.findByTestId('random-centre')
    const width = Number.parseFloat(centre.style.width)
    const height = Number.parseFloat(centre.style.height)
    // Landscape fixture in a 1600x956 window: the height is the constrained side.
    expect(height).toBeCloseTo(956 * 0.68, 0)
    expect(width).toBeGreaterThan(height)
  })

  it('scatters the small photos at different sizes', async () => {
    renderShow()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(2))
    const widths = screen.getAllByTestId('random-thumb').map((el) => Math.round(Number.parseFloat(el.style.width)))
    expect(new Set(widths).size).toBeGreaterThan(1)
  })

  it('asks for the thumbnails it is showing', async () => {
    const onShow = vi.fn()
    renderShow({ onShow })
    await waitFor(() => expect(onShow).toHaveBeenCalled())
    const shown = onShow.mock.calls.at(-1)![0] as Photo[]
    expect(shown.length).toBeGreaterThan(0)
    expect(shown[0].id).toMatch(/^p\d+$/)
  })

  it('promotes a clicked photo to the centre', async () => {
    const user = userEvent.setup()
    renderShow()
    const thumbs = await screen.findAllByTestId('random-thumb')
    const clicked = thumbs[1].getAttribute('data-photo-id')

    await user.click(thumbs[1])

    await waitFor(() => {
      const centre = screen.getByTestId('random-centre')
      const image = centre.querySelector('img')
      expect(image?.getAttribute('src')).toContain(clicked!)
    })
  })

  it('pauses while a small photo is hovered', async () => {
    renderShow()
    const thumbs = await screen.findAllByTestId('random-thumb')
    await userEvent.hover(thumbs[0])
    // The hint is the only visible evidence that the timer is held.
    await waitFor(() => expect(screen.getByText(/paused/i)).toBeInTheDocument())

    await userEvent.unhover(thumbs[0])
    await waitFor(() => expect(screen.queryByText(/paused/i)).toBeNull())
  })

  it('gives every small photo its own pose, so the layer does not look like a grid', async () => {
    renderShow()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(3))

    const thumbs = screen.getAllByTestId('random-thumb')
    const poses = thumbs.map((el) => ({
      rotate: el.style.getPropertyValue('--pose-rotate'),
      opacity: el.style.getPropertyValue('--depth-opacity'),
      blur: el.style.getPropertyValue('--depth-blur'),
      seconds: el.style.getPropertyValue('--float-seconds')
    }))

    // Every photo is tilted...
    for (const pose of poses) {
      expect(pose.rotate).toMatch(/^-?\d+(\.\d+)?deg$/)
    }
    // ...and depths actually differ, which is what makes the layer feel deep.
    expect(new Set(poses.map((pose) => pose.opacity)).size).toBeGreaterThan(1)
    // Float periods differ too, or they would bob in lockstep.
    expect(new Set(poses.map((pose) => pose.seconds)).size).toBeGreaterThan(1)
  })

  it('turns photos out of the screen plane, so they read as objects', async () => {
    renderShow()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(3))

    const thumbs = screen.getAllByTestId('random-thumb')
    for (const el of thumbs) {
      const tiltX = el.style.getPropertyValue('--tilt-x')
      const tiltY = el.style.getPropertyValue('--tilt-y')
      // A photo with no tilt is a flat rectangle.
      expect(tiltX).toMatch(/^-?\d+(\.\d+)?deg$/)
      expect(tiltY).toMatch(/^-?\d+(\.\d+)?deg$/)
      // And it sits at a real distance in the scene, not at z=0.
      const z = el.style.getPropertyValue('--depth-z')
      expect(z).toMatch(/^-?\d+(\.\d+)?px$/)
      expect(Number.parseFloat(z)).toBeLessThanOrEqual(0)
    }

    // Tilts differ across the ring; identical ones would look mechanical.
    const xs = thumbs.map((el) => el.style.getPropertyValue('--tilt-x'))
    expect(new Set(xs).size).toBeGreaterThan(1)
  })

  it('wraps the centre photo in a floating element, separate from its layout box', async () => {
    // Two nodes on purpose: the outer one is transitioned when a photo is
    // promoted, the inner one carries the float animation. Animating one node
    // would make the promotion fight the bobbing.
    renderShow()
    const centre = await screen.findByTestId('random-centre')
    expect(centre.querySelector('.random-show-float')).not.toBeNull()
    expect(centre.querySelector('.random-show-photo')).not.toBeNull()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    renderShow({ onClose })
    await screen.findByTestId('random-centre')

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from its own button', async () => {
    const onClose = vi.fn()
    renderShow({ onClose })
    await screen.findByTestId('random-centre')
    await userEvent.click(screen.getByRole('button', { name: /Leave the random show/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says so when there is nothing to show', async () => {
    renderShow({ pool: [] })
    expect(await screen.findByText(/No photos to show/i)).toBeInTheDocument()
    expect(screen.queryByTestId('random-centre')).toBeNull()
  })

  it('reports the count of photos on screen against the pool', async () => {
    renderShow()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(0))
    const shown = screen.getAllByTestId('random-thumb').length + 1
    expect(screen.getByText(new RegExp(`^${shown} of 30$`))).toBeInTheDocument()
  })

  it('advances on its own after the photo interval', async () => {
    // Fake timers with a controllable clock: `Date.now` is what `advance` reads.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    renderShow()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const first = screen.getByTestId('random-centre').querySelector('img')?.getAttribute('src')

    await act(async () => {
      vi.setSystemTime(new Date(Date.now() + PHOTO_INTERVAL_MS + 500))
      await vi.advanceTimersByTimeAsync(PHOTO_INTERVAL_MS + 500)
    })

    const second = screen.getByTestId('random-centre').querySelector('img')?.getAttribute('src')
    expect(second).not.toBe(first)
  })
})
