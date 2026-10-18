// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { I18nProvider } from '../i18n/I18nProvider'
import { Logo } from './Logo'

/** The shipped stylesheet, read from disk: jsdom evaluates no CSS. */
const stylesheet = readFileSync(join(__dirname, '..', 'styles.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The shipped app icon: the file Electron and Windows rasterise. */
const iconSource = readFileSync(join(__dirname, '..', '..', '..', 'build', 'icon.svg'), 'utf-8')

function ruleFor(selector: string): string {
  for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
    if (selectors.includes(selector)) return match[2]
  }
  throw new Error(`no rule for ${selector}`)
}

function declarationFor(selector: string, property: string): string {
  const value = ruleFor(selector).match(new RegExp(`${property}:\\s*([^;]+)`))?.[1]
  if (!value) throw new Error(`no ${property} for ${selector}`)
  return value.trim()
}

/** The `<rect>` attributes in the app icon, in paint order. */
function iconRects(): Record<string, string>[] {
  return [...iconSource.matchAll(/<rect\s+([^>]*?)\/>/g)].map(([, attributes]) =>
    Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
  )
}

const GEOMETRY = ['x', 'y', 'width', 'height', 'rx'] as const

function renderLogo(locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <Logo />
    </I18nProvider>
  )
}

describe('Logo', () => {
  it('renders the app mark with four masonry tiles', () => {
    const { container } = renderLogo()
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // Two columns with offset rows is what distinguishes the mark from a grid.
    expect(svg!.querySelectorAll('rect')).toHaveLength(5)
  })

  it('is decorative to assistive technology, with the name as a tooltip', () => {
    const { container } = renderLogo()
    // The app name is already the window title, so announcing it again would be
    // noise; the mark is hidden from the accessibility tree instead.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.toolbar-logo')).toHaveAttribute('title', 'PhotoStream')
  })

  it('shows the wordmark next to the mark', () => {
    const { container } = renderLogo()
    expect(container.querySelector('.toolbar-logo-word')?.textContent).toBe('PhotoStream')
  })

  it('is not focusable', () => {
    // Nothing happens on click, so it must not look like a control.
    const { container } = renderLogo()
    expect(container.querySelector('svg')).toHaveAttribute('focusable', 'false')
  })

  it('sits inside the window drag region', () => {
    // The far left of the bar is where a user reaches to move the window; a
    // non-draggable block there would make it feel stuck.
    expect(ruleFor('.toolbar-logo')).toContain('-webkit-app-region: drag')
  })

  it('is sized to the control height rather than an arbitrary box', () => {
    const rule = ruleFor('.toolbar-logo svg')
    expect(rule).toContain('width: 22px')
    expect(rule).toContain('height: 22px')
  })

  it('drops the wordmark when the bar gets tight', () => {
    // The columns alone still identify the app, so the text is the first thing
    // to give up when horizontal room runs out.
    expect(stylesheet).toContain('.toolbar-logo-word')
    expect(stylesheet).toMatch(/@media \(max-width: 1100px\)/)
  })
})

describe('app icon consistency', () => {
  it('uses the same geometry as the toolbar mark', () => {
    const { container } = renderLogo()
    const logoGeometry = [...container.querySelectorAll('svg rect')].map((rect) =>
      GEOMETRY.map((name) => Number(rect.getAttribute(name)))
    )
    // The shipped icon is the same mark at 512 px instead of 32 px.
    const iconGeometry = iconRects().map((rect) =>
      GEOMETRY.map((name) => Math.round((Number(rect[name] ?? 0) / 16) * 1000) / 1000)
    )
    expect(iconGeometry).toEqual(logoGeometry)
  })

  it('uses the same colours as the toolbar mark', () => {
    const [tile, light, accent, mid, dim] = iconRects()
    expect(tile.fill).toBe(declarationFor('.toolbar-logo .logo-tile', 'fill'))
    expect(light.fill).toBe(declarationFor('.toolbar-logo .logo-light', 'fill'))
    expect(accent.fill).toBe(declarationFor(':root', '--accent'))
    expect(mid.fill).toBe(declarationFor('.toolbar-logo .logo-mid', 'fill'))
    expect(mid['fill-opacity']).toBe(declarationFor('.toolbar-logo .logo-mid', 'fill-opacity'))
    expect(dim.fill).toBe(declarationFor('.toolbar-logo .logo-dim', 'fill'))
    expect(dim['fill-opacity']).toBe(declarationFor('.toolbar-logo .logo-dim', 'fill-opacity'))
  })
})
