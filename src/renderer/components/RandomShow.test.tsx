// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { RandomShow, BATCH_INTERVAL_MS, FALL_DURATION_MS, PHOTO_INTERVAL_MS } from './RandomShow'

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

  it('keeps the bar free of progress chrome', async () => {
    // A random show has no order and no end, so a "3 of 3226" counter claimed a
    // position in a sequence that does not exist. The bar now carries only the
    // pause notice and the exit button.
    renderShow()
    await waitFor(() => expect(screen.getAllByTestId('random-thumb').length).toBeGreaterThan(0))
    expect(screen.queryByText(/\bof \d+$/)).toBeNull()
    expect(document.querySelector('.random-show-count')).toBeNull()
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

  /**
   * The turnover drop.
   *
   * Timers are faked because the drop is driven by the batch interval, and the
   * removal is driven by a timer of its own — both are wall-clock rules, so
   * neither can be tested by waiting.
   */
  describe('on turnover', () => {
    /** Advance the show's clock past the batch interval and let effects settle. */
    async function turnover(): Promise<void> {
      await act(async () => {
        vi.setSystemTime(new Date(Date.now() + BATCH_INTERVAL_MS + 500))
        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS + 500)
      })
    }

    it('renders the outgoing ring as falling cards', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      renderShow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const ringBefore = screen.getAllByTestId('random-thumb').length
      expect(ringBefore).toBeGreaterThan(0)
      expect(screen.queryAllByTestId('random-falling')).toHaveLength(0)

      await turnover()

      // One falling card per outgoing ring photo: the whole batch leaves, not a
      // sample of it.
      const falling = screen.getAllByTestId('random-falling')
      expect(falling).toHaveLength(ringBefore)
    })

    it('does not let a falling card take the click', async () => {
      // They are decoration on their way out; the new ring underneath has to stay
      // clickable while they pass over it.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      renderShow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await turnover()
      for (const card of screen.getAllByTestId('random-falling')) {
        expect(card).toHaveAttribute('aria-hidden', 'true')
      }
    })

    it('removes the fallen cards once they are out of sight', async () => {
      // Otherwise every turnover would leave a hidden pile of decoded images
      // behind — with a 90-photo ring that is most of the show's memory.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      renderShow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await turnover()
      expect(screen.getAllByTestId('random-falling').length).toBeGreaterThan(0)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(FALL_DURATION_MS + 100)
      })
      expect(screen.queryAllByTestId('random-falling')).toHaveLength(0)
      // The centre survives the cleanup — only the outgoing cards are dropped.
      // (The ring itself may legitimately be empty here: this fixture's pool is
      // small enough that a turnover consumes all of it, which is covered by the
      // reducer's own tests.)
      expect(screen.getByTestId('random-centre')).toBeInTheDocument()
    })
  })

  /**
   * The hover state, read from the stylesheet.
   *
   * jsdom applies no CSS and resolves no `:hover`, so the rule cannot be observed
   * on an element; reading the shipped file is the only way to assert it.
   */
  describe('hover styling', () => {
    const stylesheet = readFileSync(join(__dirname, '..', 'styles.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

    /** The body of the first rule whose selector list contains `selector`. */
    function cssRule(selector: string): string {
      for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1]
          .split(',')
          .map((part) => part.replace(/\s+/g, ' ').trim())
          .filter((part) => part.length > 0)
        if (selectors.includes(selector)) return match[2]
      }
      throw new Error(`no rule for ${selector}`)
    }

    const hoverBody = () => cssRule('.random-show-thumb:hover')

    it('keeps the reading of the pose the card already had', async () => {
      // Squaring the card up on hover both broke the illusion (one card facing
      // front among tilted ones reads as a different object) and caused a hover
      // flicker, because straightening moves the outline under the pointer.
      expect(hoverBody()).not.toMatch(/rotateX\(\s*0deg\s*\)/)
      expect(hoverBody()).not.toMatch(/rotateY\(\s*0deg\s*\)/)
      expect(hoverBody()).not.toMatch(/rotate\(\s*0deg\s*\)/)
    })

    it('does not replace the animated transform', async () => {
      // A running animation outranks `transform` declarations, so anything in
      // here would either be ignored or would have to stop the animation.
      expect(hoverBody()).not.toMatch(/(^|[\s;])transform\s*:/)
      expect(hoverBody()).not.toMatch(/animation\s*:\s*none/)
    })

    it('grows the card on hover rather than moving it', async () => {
      // Growing about the card's own centre can never take the pointer out of
      // the card, which is what keeps overlapping photos from vibrating.
      expect(hoverBody()).toMatch(/(^|[\s;])scale\s*:/)
      expect(hoverBody()).not.toMatch(/(^|[\s;])translate\s*:/)
      expect(hoverBody()).toMatch(/animation-play-state\s*:\s*paused/)
    })

    it('pauses the float animation so a click lands where it was aimed', async () => {
      // `none` would snap the card back to its resting pose; `paused` freezes it
      // exactly where the animation had it.
      expect(hoverBody()).toMatch(/animation-play-state\s*:\s*paused/)
      expect(cssRule('.random-show-thumb')).toMatch(/animation-play-state|animation:/)
    })

    it('keeps the reduced-motion hover consistent with the animated one', async () => {
      // Reduced motion has no animation to compose with, so the pose has to be
      // restated — but it must still be the card's own tilt, not a squared-up one.
      const reduced = stylesheet.slice(stylesheet.indexOf('@media (prefers-reduced-motion: reduce)'))
      const block = reduced.slice(reduced.indexOf('.random-show-thumb:hover'))
      const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'))
      expect(body).not.toMatch(/rotateX\(\s*0deg\s*\)/)
      expect(body).not.toMatch(/rotateY\(\s*0deg\s*\)/)
    })
  })

  /**
   * The photos are meant to read as physical prints, not as flat rectangles.
   *
   * That needs two things the geometry tests cannot see: a paper margin around
   * the image, and an edge with actual thickness that the tilt exposes. Both are
   * CSS, so both are asserted against the shipped stylesheet.
   */
  describe('paper body', () => {
    const stylesheet = readFileSync(join(__dirname, '..', 'styles.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

    function cssRule(selector: string): string {
      for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1]
          .split(',')
          .map((part) => part.replace(/\s+/g, ' ').trim())
          .filter((part) => part.length > 0)
        if (selectors.includes(selector)) return match[2]
      }
      throw new Error(`no rule for ${selector}`)
    }

    it('leaves a paper margin around the image', async () => {
      // Without padding the image goes edge to edge and the card reads as a
      // crop, not a print.
      expect(cssRule('.random-show-thumb')).toMatch(/(^|[\s;])padding\s*:\s*[1-9]/)
      expect(cssRule('.random-show-centre img')).toMatch(/(^|[\s;])padding\s*:\s*[1-9]/)
    })

    it('paints the sheet rather than leaving it see-through', async () => {
      // A transparent margin would show the backdrop through the border and
      // destroy the effect; the gradient is what makes the surface catch light.
      const body = cssRule('.random-show-thumb')
      expect(body).toMatch(/(^|(\s))background\s*:\s*linear-gradient/)
      expect(body).not.toMatch(/(^|(\s))background\s*:\s*transparent/)
    })

    it('draws the cut edge as a hard offset shadow', async () => {
      // Two opaque zero-blur shadows give the print a side. They have to be part
      // of `box-shadow` rather than a pseudo-element offset in Z: `filter` and
      // `opacity` are grouping properties and force `transform-style` to `flat`,
      // which would flatten the offset into a normal positioned box painted over
      // the photo — the card then renders as an empty grey frame.
      const body = cssRule('.random-show-thumb')
      expect(body).toMatch(/box-shadow[^;]*1px 2px 0/)
      expect(body).toMatch(/box-shadow[^;]*2px 3px 0/)
    })

    it('never paints an opaque pseudo-element over the photo', async () => {
      // The regression guard for the empty-frame bug: any absolutely positioned
      // `::before` with `inset: 0` on the card sits above the in-flow image and
      // hides it completely.
      expect(() => cssRule('.random-show-thumb::before')).toThrow()
    })
  })
})
