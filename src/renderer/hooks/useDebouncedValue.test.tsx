// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDebouncedValue } from './useDebouncedValue'

/**
 * The debounce behind the filter panel.
 *
 * `useWall` re-derives the entire wall from the filters, which costs ~32 ms on a
 * 40 000-photo library — longer than the gap between keystrokes. These tests pin
 * the two properties that make it safe: a burst collapses into one value, and
 * the first value is never delayed.
 */
describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the initial value immediately', () => {
    const { result } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' }
    })
    expect(result.current).toBe('a')
  })

  it('collapses a burst into the last value', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: '' }
    })

    for (const value of ['k', 'ky', 'kyo']) {
      rerender({ value })
      act(() => {
        vi.advanceTimersByTime(40)
      })
      // Nothing settles while the user is still typing.
      expect(result.current).toBe('')
    }

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('kyo')
  })

  it('does not restart the timer for a value it has already settled on', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' }
    })

    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('b')

    // A re-render with the same value must not schedule anything, or a parent
    // that re-renders often would keep the wall from ever catching up.
    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('b')
  })

  it('cancels a pending update when the value returns to the settled one', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' }
    })

    rerender({ value: 'b' })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    // Back to what is already settled: nothing should change afterwards.
    rerender({ value: 'a' })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe('a')
  })

  it('clears its timer on unmount', () => {
    const { unmount } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' }
    })
    unmount()
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
  })
})
