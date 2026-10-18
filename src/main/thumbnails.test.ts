import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ensureThumbnail, ensureThumbnails, thumbPath, type ThumbRequest } from './thumbnails'
import { THUMB_SIZES } from '../shared/thumbs'

let cacheDir = ''
let sourceDir = ''
let sourcePath = ''
let sourceStat = { mtimeMs: 0, size: 0 }

async function makeSource(width = 1200, height = 800): Promise<void> {
  sourcePath = join(sourceDir, 'source.jpg')
  await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 120 } } })
    .jpeg()
    .toFile(sourcePath)
  const info = await stat(sourcePath)
  sourceStat = { mtimeMs: info.mtimeMs, size: info.size }
}

function request(level: 'wall' | 'zoom' = 'wall'): ThumbRequest {
  return { sourcePath, mtimeMs: sourceStat.mtimeMs, sizeBytes: sourceStat.size, level }
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-thumbs-'))
  sourceDir = await mkdtemp(join(tmpdir(), 'photostream-src-'))
  await makeSource()
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

describe('thumbPath', () => {
  it('is deterministic for the same request', () => {
    expect(thumbPath(cacheDir, request())).toBe(thumbPath(cacheDir, request()))
  })

  it('produces a .webp file named after the level', () => {
    expect(thumbPath(cacheDir, request('wall'))).toMatch(/-wall\.webp$/)
    expect(thumbPath(cacheDir, request('zoom'))).toMatch(/-zoom\.webp$/)
  })
})

describe('ensureThumbnail', () => {
  it('creates a WebP thumbnail bounded by the level size', async () => {
    const file = await ensureThumbnail(cacheDir, request('wall'))
    const metadata = await sharp(file).metadata()

    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBeLessThanOrEqual(THUMB_SIZES.wall)
    expect(metadata.height).toBeLessThanOrEqual(THUMB_SIZES.wall)
    // 1200x800 scaled down keeps its aspect ratio.
    expect(metadata.width).toBe(512)
    expect(metadata.height).toBe(341)
  })

  it('does not enlarge a small source', async () => {
    await makeSource(200, 100)
    const file = await ensureThumbnail(cacheDir, request('wall'))
    const metadata = await sharp(file).metadata()
    expect(metadata.width).toBe(200)
  })

  it('reuses an existing thumbnail instead of re-encoding', async () => {
    const first = await ensureThumbnail(cacheDir, request('wall'))
    const firstMtime = (await stat(first)).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await ensureThumbnail(cacheDir, request('wall'))

    expect(second).toBe(first)
    expect((await stat(second)).mtimeMs).toBe(firstMtime)
  })

  it('creates missing cache directories', async () => {
    const nested = join(cacheDir, 'a', 'b', 'c')
    const file = await ensureThumbnail(nested, request('wall'))
    expect((await stat(file)).size).toBeGreaterThan(0)
  })

  it('rebuilds when the source changes', async () => {
    const before = await ensureThumbnail(cacheDir, request('wall'))

    await new Promise((resolve) => setTimeout(resolve, 20))
    await makeSource(800, 800)
    const after = await ensureThumbnail(cacheDir, request('wall'))

    expect(after).not.toBe(before)
  })

  it('does not lock the source file after encoding', async () => {
    // Regression guard for a real Windows workflow: Lightroom re-exports over
    // the same file name while the wall is open. libvips keeps source handles
    // mapped unless its cache is disabled, which made that write fail with
    // "unable to open for write".
    await ensureThumbnail(cacheDir, request('wall'))

    await expect(
      sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 9, b: 9 } } })
        .jpeg()
        .toFile(sourcePath)
    ).resolves.toBeDefined()
  })

  it('does not lock the thumbnail it just wrote', async () => {
    const file = await ensureThumbnail(cacheDir, request('wall'))
    await sharp(file).metadata()

    await expect(rm(file, { force: true })).resolves.toBeUndefined()
  })

  it('keeps the two levels separate', async () => {
    const wall = await ensureThumbnail(cacheDir, request('wall'))
    const zoom = await ensureThumbnail(cacheDir, request('zoom'))
    expect(wall).not.toBe(zoom)

    const wallMeta = await sharp(wall).metadata()
    const zoomMeta = await sharp(zoom).metadata()
    expect(wallMeta.width).toBeLessThan(zoomMeta.width as number)
  })

  it('leaves no temporary files after success', async () => {
    await ensureThumbnail(cacheDir, request('wall'))
    const files = await readdir(cacheDir)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('encodes once when the same rendition is requested concurrently', async () => {
    // This happens on every folder open: the library pre-warms all thumbnails
    // while the renderer asks for the visible ones. Two encodes would make the
    // second `rename` fail on Windows with EPERM because the target exists.
    const results = await Promise.all([
      ensureThumbnail(cacheDir, request('wall')),
      ensureThumbnail(cacheDir, request('wall')),
      ensureThumbnail(cacheDir, request('wall'))
    ])

    expect(new Set(results).size).toBe(1)
    // Exactly one cached rendition, and no stray temp files.
    const files = await readdir(cacheDir)
    expect(files.filter((name) => name.endsWith('.webp'))).toHaveLength(1)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('handles concurrent requests for different levels', async () => {
    const [wall, zoom] = await Promise.all([
      ensureThumbnail(cacheDir, request('wall')),
      ensureThumbnail(cacheDir, request('zoom'))
    ])

    expect(wall).not.toBe(zoom)
    expect((await sharp(wall).metadata()).width).toBeLessThan((await sharp(zoom).metadata()).width as number)
  })

  it('throws and cleans up for an unreadable source', async () => {
    const broken = join(sourceDir, 'broken.jpg')
    await writeFile(broken, 'not an image')
    const info = await stat(broken)

    await expect(
      ensureThumbnail(cacheDir, { sourcePath: broken, mtimeMs: info.mtimeMs, sizeBytes: info.size, level: 'wall' })
    ).rejects.toThrow()

    const files = await readdir(cacheDir)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})

describe('ensureThumbnails', () => {
  it('builds every requested thumbnail', async () => {
    const requests = [request('wall'), request('zoom')]
    const result = await ensureThumbnails(cacheDir, requests)
    expect(result).toEqual({ built: 2, failed: 0 })
  })

  it('reports progress once per photo', async () => {
    const seen: Array<[number, number]> = []
    await ensureThumbnails(cacheDir, [request('wall')], { onDone: (done, total) => seen.push([done, total]) })
    expect(seen).toEqual([[1, 1]])
  })

  it('counts failures instead of aborting the batch', async () => {
    const broken = join(sourceDir, 'broken.jpg')
    await writeFile(broken, 'nope')
    const info = await stat(broken)

    const result = await ensureThumbnails(cacheDir, [
      request('wall'),
      { sourcePath: broken, mtimeMs: info.mtimeMs, sizeBytes: info.size, level: 'wall' }
    ])

    expect(result.built).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('handles an empty request list', async () => {
    expect(await ensureThumbnails(cacheDir, [])).toEqual({ built: 0, failed: 0 })
  })

  it('stops early when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await ensureThumbnails(cacheDir, [request('wall'), request('zoom')], {
      signal: controller.signal
    })
    expect(result.built).toBe(0)
  })
})
