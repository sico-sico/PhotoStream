import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/**
 * Shared setup for every test file.
 *
 * Runs in both `node` and `jsdom` environments, so every DOM-touching block is
 * guarded: a main-process test must not fail because `Element` does not exist.
 */

afterEach(() => {
  // React Testing Library does not auto-clean with `globals: false`.
  cleanup()
})

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

if (hasDom) {
  // jsdom implements neither of these, and both are used by the wall.
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, writable: true })
  }

  if (!('matchMedia' in globalThis)) {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })
  }

  // jsdom has no layout engine, so `getBoundingClientRect` always reports
  // zeros. The pan/zoom code reads it to convert pointer positions into world
  // coordinates, so tests can override it per element when they care.
  if (typeof Element !== 'undefined' && !Element.prototype.getBoundingClientRect) {
    Element.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({})
    })
  }
}
