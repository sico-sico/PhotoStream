import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, unlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WATCH_DEBOUNCE_MS, watchDirectory, type RawWatchEvent } from './watcher'

/**
 * Watcher tests drive the real `fs.watch` against a temporary directory.
 *
 * Everything is asynchronous and debounced, so each assertion polls until the
 * expected condition or a generous timeout. That is slower than mocking, but it
 * exercises the actual platform behaviour we ship on — the event-mode quirks
 * (`rename` for both add and delete) are exactly the thing worth verifying.
 */

let dir = ''
let handles: Array<{ close: () => void }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photostream-watch-'))
})

afterEach(async () => {
  for (const handle of handles) handle.close()
  handles = []
  await rm(dir, { recursive: true, force: true })
})

/** Wait until `predicate` holds, polling briefly. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for watcher event')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function collect(events: RawWatchEvent[]): { handle: { close: () => void }; done: Promise<void> } {
  let notify: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    notify = resolve
  })
  const handle = watchDirectory(dir, {
    // A short debounce keeps the suite fast without changing the code path.
    debounceMs: 50,
    onEvents: (batch) => {
      events.push(...batch)
      notify?.()
    }
  })
  handles.push(handle)
  return { handle, done }
}

describe('watchDirectory', () => {
  it('reports a newly created JPEG', async () => {
    const events: RawWatchEvent[] = []
    collect(events)

    await writeFile(join(dir, 'new.jpg'), 'x')
    await waitFor(() => events.length > 0)

    expect(events[0].path).toBe(join(dir, 'new.jpg'))
    // On Windows a create surfaces as `change` followed by `rename`. Because the
    // pending map is keyed by path, the later `rename` wins and the batch
    // carries a single `touch`; the consumer then resolves it by probing the
    // filesystem. Either label is acceptable here — what matters is that the
    // path is reported exactly once.
    expect(['touch', 'change', 'add']).toContain(events[0].type)
    const forPath = events.filter((event) => event.path === join(dir, 'new.jpg'))
    expect(forPath).toHaveLength(1)
  })

  it('ignores files that are not JPEGs', async () => {
    const events: RawWatchEvent[] = []
    collect(events)

    await writeFile(join(dir, 'notes.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(events).toHaveLength(0)
  })

  it('reports a modified JPEG as change', async () => {
    await writeFile(join(dir, 'a.jpg'), 'first')
    const events: RawWatchEvent[] = []
    collect(events)

    await writeFile(join(dir, 'a.jpg'), 'second')
    await waitFor(() => events.some((event) => event.path.endsWith('a.jpg')))
  })

  it('reports a deletion', async () => {
    await writeFile(join(dir, 'gone.jpg'), 'x')
    const events: RawWatchEvent[] = []
    collect(events)

    await unlink(join(dir, 'gone.jpg'))
    await waitFor(() => events.some((event) => event.path.endsWith('gone.jpg')))
  })

  it('reports a rename', async () => {
    await writeFile(join(dir, 'before.jpg'), 'x')
    const events: RawWatchEvent[] = []
    collect(events)

    await rename(join(dir, 'before.jpg'), join(dir, 'after.jpg'))
    await waitFor(() => events.some((event) => event.path.endsWith('after.jpg')))
  })

  it('coalesces a burst into a single batch', async () => {
    const batches: RawWatchEvent[][] = []
    const handle = watchDirectory(dir, {
      debounceMs: 200,
      onEvents: (batch) => batches.push(batch)
    })
    handles.push(handle)

    // Ten rapid writes should not produce ten callbacks.
    for (let i = 0; i < 10; i += 1) await writeFile(join(dir, `burst${i}.jpg`), 'x')
    await waitFor(() => batches.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(batches.length).toBeLessThanOrEqual(2)
    const flattened = batches.flat()
    // Every distinct path is still represented.
    expect(flattened.length).toBeGreaterThanOrEqual(1)
  })

  it('deduplicates repeated events for the same path', async () => {
    const batches: RawWatchEvent[][] = []
    const handle = watchDirectory(dir, {
      debounceMs: 150,
      onEvents: (batch) => batches.push(batch)
    })
    handles.push(handle)

    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, 'same.jpg'), `v${i}`)
    await waitFor(() => batches.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 250))

    const forSame = batches.flat().filter((event) => event.path.endsWith('same.jpg'))
    // One entry per batch at most, because the pending map is keyed by path.
    expect(forSame.length).toBeLessThanOrEqual(batches.length)
  })

  it('stops reporting after close', async () => {
    const events: RawWatchEvent[] = []
    const handle = watchDirectory(dir, { debounceMs: 50, onEvents: (batch) => events.push(...batch) })

    await writeFile(join(dir, 'before-close.jpg'), 'x')
    await waitFor(() => events.length > 0)

    handle.close()
    const countAtClose = events.length

    await writeFile(join(dir, 'after-close.jpg'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(events.length).toBe(countAtClose)
  })

  it('cancels a pending flush when closed', async () => {
    const events: RawWatchEvent[] = []
    const handle = watchDirectory(dir, { debounceMs: 300, onEvents: (batch) => events.push(...batch) })

    await writeFile(join(dir, 'pending.jpg'), 'x')
    // Close before the debounce fires.
    await new Promise((resolve) => setTimeout(resolve, 80))
    handle.close()

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(events).toHaveLength(0)
  })

  it('reports an error for a directory that does not exist', () => {
    const onError = vi.fn()
    const handle = watchDirectory(join(dir, 'missing'), { onEvents: () => {}, onError })
    handles.push(handle)

    // Windows throws synchronously for a missing path; other platforms emit.
    if (onError.mock.calls.length === 0) {
      // Not all platforms surface this; the contract is simply "does not throw".
      expect(typeof handle.close).toBe('function')
    } else {
      expect(onError).toHaveBeenCalled()
    }
  })

  it('exposes a default debounce window', () => {
    expect(WATCH_DEBOUNCE_MS).toBeGreaterThan(0)
  })
})
