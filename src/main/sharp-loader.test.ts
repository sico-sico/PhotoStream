import { describe, expect, it } from 'vitest'
import { loadSharp } from './sharp-loader'

describe('loadSharp', () => {
  /**
   * The reason `sharp` is wrapped rather than imported directly at the top of
   * `metadata.ts` and `thumbnails.ts`: forgetting `cache(false)` leaves source
   * files locked on Windows until the process exits, which breaks re-exporting a
   * photo over itself while the wall is open. `thumbnails.test.ts` covers the
   * symptom; this covers the invariant.
   */
  it('returns libvips with its cache disabled', async () => {
    const sharp = await loadSharp()
    const cache = sharp.cache()
    expect(cache.memory.max).toBe(0)
    expect(cache.files.max).toBe(0)
    expect(cache.items.max).toBe(0)
  })

  it('resolves the same module every time', async () => {
    const [first, second] = await Promise.all([loadSharp(), loadSharp()])
    expect(second).toBe(first)
  })
})
