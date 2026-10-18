import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Photo, ScanResult } from '../shared/types'
import type { DirectoryWatcher } from './watcher'

/**
 * Opening two folders in quick succession.
 *
 * Dragging several folders onto the window — or clicking through the recent
 * list faster than a scan finishes — starts one `open()` while the previous one
 * is still running. These tests pin down what the library does when that
 * happens, because the answer decides whether the last drop is the one you see.
 *
 * `scanDirectory` is mocked so the order the two scans finish in can be chosen
 * rather than raced for: real scans finish in whatever order the disk decides,
 * which is exactly why the bug is not reproducible by hand.
 */

const pending: Array<{ dir: string; finish: (result: ScanResult) => void }> = []

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

vi.mock('./scanner', () => ({
  scanDirectory: (dir: string) =>
    new Promise<ScanResult>((resolve) => {
      pending.push({ dir, finish: resolve })
    })
}))

const closed: string[] = []
const watched: string[] = []

vi.mock('./watcher', () => ({
  watchDirectory: (dir: string): DirectoryWatcher => {
    watched.push(dir)
    return {
      close: () => {
        closed.push(dir)
      }
    }
  }
}))

const { PhotoLibrary } = await import('./ipc')

/** A photo as the mocked scanner would report it. */
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

function result(dir: string, photos: Photo[]): ScanResult {
  return { dir, photos, skipped: 0, durationMs: 1 }
}

/** Let the queued `open()` calls reach their scan. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let library: InstanceType<typeof PhotoLibrary>
let cacheDir = ''

beforeEach(async () => {
  pending.length = 0
  closed.length = 0
  watched.length = 0
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-race-'))
  library = new PhotoLibrary(cacheDir, () => undefined)
})

afterEach(async () => {
  library.close()
  await library.drain()
  await rm(cacheDir, { recursive: true, force: true })
})

describe('PhotoLibrary under overlapping opens', () => {
  it('keeps the folder that was opened last, even if its scan finishes first', async () => {
    // The user drops A, then B. B is small and finishes immediately; A is a
    // year of photos and lands a second later.
    const openA = library.open('C:/photos/a')
    const openB = library.open('C:/photos/b')
    await settle()

    expect(pending.map((entry) => entry.dir)).toEqual(['C:/photos/a', 'C:/photos/b'])

    // B, the most recent request, resolves first.
    pending[1].finish(result('C:/photos/b', [photo('C:/photos/b', 'b.jpg')]))
    await openB
    expect(library.directory).toBe('C:/photos/b')

    // A then resolves. The user's last action was opening B, so A must not win.
    pending[0].finish(result('C:/photos/a', [photo('C:/photos/a', 'a.jpg')]))
    await openA

    expect(library.directory).toBe('C:/photos/b')
    expect(library.all.map((item) => item.name)).toEqual(['b.jpg'])
  })

  it('only ever watches the folder that ends up open', async () => {
    // Watchers are the expensive part: a recursive watch on a large tree holds
    // handles and keeps delivering events for a library nobody is looking at.
    // Starting one for an abandoned scan is the bug; closing it again afterwards
    // would still have paid for it.
    const openA = library.open('C:/photos/a')
    const openB = library.open('C:/photos/b')
    await settle()

    pending[0].finish(result('C:/photos/a', [photo('C:/photos/a', 'a.jpg')]))
    await openA
    pending[1].finish(result('C:/photos/b', [photo('C:/photos/b', 'b.jpg')]))
    await openB

    expect(library.directory).toBe('C:/photos/b')
    expect(watched).toEqual(['C:/photos/b'])
    // And the surviving watcher is still live: closing everything is a different
    // bug from closing the wrong one.
    expect(closed).not.toContain('C:/photos/b')
  })

  it('cancels the abandoned scan instead of letting it read the whole tree', async () => {
    // A scan of a large folder reads EXIF for every file; leaving it running
    // after the user has moved on is pure waste, and on a network or slow disk
    // it is minutes of it.
    const openA = library.open('C:/photos/a')
    const openB = library.open('C:/photos/b')
    await settle()

    const scanA = library.scanSignals?.[0]
    expect(scanA?.aborted).toBe(true)
    pending[1].finish(result('C:/photos/b', []))
    await openB
    pending[0].finish(result('C:/photos/a', []))
    await openA
  })
})
