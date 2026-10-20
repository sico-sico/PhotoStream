import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { Photo, ScanResult } from '../shared/types'
import { ThumbCache } from './cache-maintenance'

/**
 * Two folders dropped close together.
 *
 * The `openDropped` handler resolves the target (`stat`) before it opens the
 * library, so the order two drops reach the library is the order their `stat`
 * calls happen to finish — not the order the user dropped them. A path on a slow
 * drive or a sleeping network share delays only its own resolve, and the drop
 * that arrived *first* then opens *last* and wins.
 *
 * The renderer guards its own state, but the main process would still be serving
 * `pic://` from the other directory, so every thumbnail on the wall would 404 —
 * which looks exactly like "the folder did not open".
 *
 * Handlers are captured from the mocked `ipcMain` so the real code path is
 * exercised rather than a copy of it.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const scans: Array<{ dir: string; finish: (result: ScanResult) => void }> = []
/** `stat` delays, keyed by dropped path, so resolution order can be chosen. */
let resolveDelays: Record<string, number> = {}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

vi.mock('./scanner', () => ({
  scanDirectory: (dir: string) =>
    new Promise<ScanResult>((resolve) => {
      scans.push({ dir, finish: resolve })
    })
}))

vi.mock('./watcher', () => ({
  watchDirectory: () => ({ close: () => undefined })
}))

vi.mock('./drop', () => ({
  resolveOpenTarget: async (target: string) => {
    const delay = resolveDelays[target] ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return { dir: target, photo: '' }
  },
  photoFromArgv: () => ''
}))

const { PhotoLibrary, registerIpc } = await import('./ipc')

function photo(dir: string, name: string): Photo {
  return {
    id: join(dir, name).toLowerCase(),
    path: join(dir, name),
    name,
    width: 100,
    height: 100,
    takenAt: '2020-01-01',
    dateSource: 'exif',
    mtimeMs: 1,
    sizeBytes: 1
  }
}

function result(dir: string): ScanResult {
  return { dir, photos: [photo(dir, 'x.jpg')], skipped: 0, durationMs: 1 }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let library: InstanceType<typeof PhotoLibrary>
let cacheDir = ''

beforeEach(async () => {
  handlers.clear()
  scans.length = 0
  resolveDelays = {}
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-order-'))
  library = new PhotoLibrary(cacheDir, () => undefined)
  registerIpc({
    library,
    dataDir: cacheDir,
    cache: new ThumbCache(cacheDir),
    appVersion: '0',
    versions: { electron: '0', chromium: '0' },
    systemLocales: []
  })
})

afterEach(async () => {
  library.close()
  await library.drain()
  await rm(cacheDir, { recursive: true, force: true })
})

describe('dropping two folders quickly', () => {
  it('opens the one dropped last even when the first resolves its path slower', async () => {
    const dropped = handlers.get(IPC.openDropped)
    expect(dropped).toBeDefined()

    // A is dropped first but its `stat` is slow; B is dropped second.
    resolveDelays = { 'D:/a': 50 }
    const first = dropped!({ sender: {} }, 'D:/a') as Promise<unknown>
    const second = dropped!({ sender: {} }, 'D:/b') as Promise<unknown>

    await sleep(80)

    // Both scans are in flight. Whichever order they reach the library is fine;
    // what matters is which one is allowed to win.
    for (const scan of scans) scan.finish(result(scan.dir))
    await Promise.all([first, second])

    // The user dropped B last, so B is the folder they expect.
    expect(library.directory).toBe('D:/b')
  })
})
