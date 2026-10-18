import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { RawWatchEvent } from './watcher'

/**
 * Watcher events that arrive after the library has moved on.
 *
 * `fs.watch` delivers events asynchronously and the handler then awaits `stat`
 * plus an EXIF read before folding the result in. Opening a different folder in
 * that window used to leave the old handler running with the *new* photo list as
 * its target, so a file from the previous folder was spliced into the wall the
 * user had just opened.
 *
 * This is the drag-a-folder-in-immediately case: the watcher for the outgoing
 * library is still flushing while the incoming folder is being scanned.
 *
 * The watcher is mocked so the stale batch can be fired at a chosen moment, with
 * a real file behind it — a fake path would fail `stat` and never reach the
 * splice.
 */

const watchers: Array<{ dir: string; emit: (events: RawWatchEvent[]) => void }> = []

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

vi.mock('./watcher', () => ({
  watchDirectory: (dir: string, options: { onEvents: (events: RawWatchEvent[]) => void }) => {
    const entry = { dir, emit: options.onEvents }
    watchers.push(entry)
    return { close: () => undefined }
  }
}))

const { PhotoLibrary } = await import('./ipc')

let root = ''
let cacheDir = ''
let library: InstanceType<typeof PhotoLibrary>
let notices: Array<{ channel: string; payload: unknown }> = []

async function jpeg(dir: string, name: string): Promise<string> {
  const path = join(dir, name)
  await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 90, b: 160 } } })
    .jpeg()
    .toFile(path)
  return path
}

/** Let the watcher's async handler finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

beforeEach(async () => {
  watchers.length = 0
  notices = []
  root = await mkdtemp(join(tmpdir(), 'photostream-watch-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-watchcache-'))
  library = new PhotoLibrary(cacheDir, (channel, payload) => notices.push({ channel, payload }))
})

afterEach(async () => {
  library.close()
  await library.drain()
  await rm(root, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

describe('watcher events from a previous library', () => {
  it('does not splice an old folder photo into the newly opened one', async () => {
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toFile(join(root, 'seed.jpg'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })
    const aPhoto = await jpeg(dirA, 'a.jpg')
    await jpeg(dirB, 'b.jpg')

    await library.open(dirA)
    const watcherA = watchers.find((entry) => entry.dir === dirA)
    expect(watcherA).toBeDefined()

    // The user drops B in straight away.
    await library.open(dirB)
    expect(library.directory).toBe(dirB)
    expect(library.all.map((photo) => photo.name)).toEqual(['b.jpg'])

    // A's watcher had already queued this event; it lands now.
    watcherA!.emit([{ type: 'change', path: aPhoto }])
    await settle()

    const names = library.all.map((photo) => photo.name)
    expect(names).toEqual(['b.jpg'])
  })

  it('does not report a delta that describes the previous folder', async () => {
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })
    const aPhoto = await jpeg(dirA, 'a.jpg')
    await jpeg(dirB, 'b.jpg')

    await library.open(dirA)
    const watcherA = watchers.find((entry) => entry.dir === dirA)!
    await library.open(dirB)
    notices.length = 0

    watcherA.emit([{ type: 'change', path: aPhoto }])
    await settle()

    // The renderer replaces its photo list with whatever a delta carries, so a
    // stale delta is enough on its own to show the wrong folder.
    const deltas = notices.filter((notice) => notice.channel.includes('photos-changed'))
    for (const delta of deltas) {
      const photos = (delta.payload as { photos?: Array<{ name: string }> }).photos ?? []
      expect(photos.map((photo) => photo.name)).not.toContain('a.jpg')
    }
  })
})
