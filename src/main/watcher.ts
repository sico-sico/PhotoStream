import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { isSupportedImage } from './scanner'

/**
 * Directory watching.
 *
 * Node's built-in `fs.watch` with `recursive: true` is used instead of
 * `chokidar`: the app only targets Windows (where recursive watching is
 * supported natively), and dropping the dependency removes a whole
 * ESM/CJS/microtask surface we would otherwise have to keep current.
 *
 * Events are coalesced because a single Lightroom export can emit a burst of
 * hundreds of events, and re-reading metadata for each one would stall the
 * main process.
 */

export type WatchEventType = 'add' | 'change' | 'remove'

/**
 * Raw watcher output. `touch` means fs.watch reported `rename`, which covers
 * both creation and deletion; it is resolved to add/remove by the consumer.
 */
export type RawWatchEventType = WatchEventType | 'touch'

export interface WatchEvent {
  type: WatchEventType
  path: string
}

export interface RawWatchEvent {
  type: RawWatchEventType
  path: string
}

export const WATCH_DEBOUNCE_MS = 400

export interface WatchOptions {
  debounceMs?: number
  onEvents: (events: RawWatchEvent[]) => void
  onError?: (error: Error) => void
}

export interface DirectoryWatcher {
  close: () => void
}

/**
 * Start watching `dir`. Returns a handle whose `close()` detaches the watcher
 * and cancels any pending debounce timer.
 */
export function watchDirectory(dir: string, options: WatchOptions): DirectoryWatcher {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS
  const pending = new Map<string, RawWatchEventType>()
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const flush = (): void => {
    timer = null
    if (closed || pending.size === 0) return
    const events: RawWatchEvent[] = [...pending].map(([path, type]) => ({ type, path }))
    pending.clear()
    options.onEvents(events)
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(flush, debounceMs)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
      // `filename` is null on some platforms; without it we cannot attribute the
      // change, so ignore rather than guess.
      if (!filename) return
      if (!isSupportedImage(filename)) return

      const absolute = join(dir, filename)
      // fs.watch reports `rename` for both creation and deletion and does not
      // say which. Record it as `touch`; the consumer resolves the ambiguity
      // by checking whether the file exists when the batch is flushed.
      pending.set(absolute, eventType === 'rename' ? 'touch' : 'change')
      schedule()
    })
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)))
    return { close: () => undefined }
  }

  watcher.on('error', (error) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    close: () => {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      watcher.close()
    }
  }
}
