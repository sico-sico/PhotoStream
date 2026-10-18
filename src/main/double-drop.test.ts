import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * Double-drop with the real scanner.
 *
 * The other ordering tests mock `scanDirectory` so the finish order can be
 * chosen; this one uses the real one, with genuinely different folder sizes, so
 * the two scans take genuinely different amounts of time. That is the shape of
 * the user's report: drop a big folder, then a small one straight after, and the
 * small one must be what stays on screen.
 */

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

const { PhotoLibrary } = await import('./ipc')

let root = ''
let cacheDir = ''
let library: InstanceType<typeof PhotoLibrary>

async function makeFolder(name: string, count: number): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      sharp({ create: { width: 48, height: 36, channels: 3, background: { r: i % 200, g: 90, b: 140 } } })
        .jpeg()
        .toFile(join(dir, `${name}-${i}.jpg`))
    )
  )
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photostream-realorder-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-realordercache-'))
  library = new PhotoLibrary(cacheDir, () => undefined)
})

afterEach(async () => {
  library.close()
  await library.drain()
  await rm(root, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

describe('double drop with the real scanner', () => {
  it('leaves the small folder open when it was dropped after the big one', async () => {
    // A large folder takes visibly longer to scan than a tiny one.
    const big = await makeFolder('big', 180)
    const small = await makeFolder('small', 4)

    const first = library.open(big)
    const second = library.open(small)
    await Promise.all([first, second])

    expect(library.directory).toBe(small)
    expect(library.all.every((photo) => photo.name.startsWith('small-'))).toBe(true)
  })

  it('leaves the big folder open when it was dropped last', async () => {
    // The mirror case, so the rule is "last dropped wins" rather than
    // "smallest/slowest wins".
    const big = await makeFolder('big', 180)
    const small = await makeFolder('small', 4)

    const first = library.open(small)
    const second = library.open(big)
    await Promise.all([first, second])

    expect(library.directory).toBe(big)
    expect(library.all.every((photo) => photo.name.startsWith('big-'))).toBe(true)
  })
})
