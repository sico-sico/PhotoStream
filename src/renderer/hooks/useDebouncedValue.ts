import { useEffect, useState } from 'react'

/**
 * A value that only catches up after it has stopped changing.
 *
 * Used for filters. Re-deriving the wall from a filter edit costs ~32 ms on
 * 40 000 photos, so applying every keystroke makes the input itself lag behind
 * the keyboard. Waiting for a pause turns a burst of typing into one pass.
 *
 * Deliberately a plain timeout rather than a transition: `useDeferredValue`
 * would still run the expensive pass once per keystroke, just at a lower
 * priority, and the point here is not to run it at all until the typing stops.
 *
 * The first value is returned as-is, so nothing is delayed on mount.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    // Equal values must not restart the timer: a parent re-render that produces
    // an equal filter object would otherwise keep the wall from ever catching up.
    if (Object.is(settled, value)) return
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
    // `settled` is read only to detect that the values already match; including
    // it cannot cause a loop, because setting it ends the comparison.
  }, [value, delayMs, settled])

  return settled
}
