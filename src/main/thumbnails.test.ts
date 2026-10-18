import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, readdir, writeFile } from 'node:fs/promises'

/**
 * Every file under the cache, recursively.
 *
 * Renditions live in sharded subdirectories (`a/b/hash-wall.webp`), so a flat
 * `readdir` of the cache root only sees directories. Tests that count files must
 * walk the tree, or they would silently assert on an empty list.
 */
async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await allFiles(full)))
    else files.push(full)
  }
  return files
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  THUMB_QUALITY,
  VIEWER_QUALITY,
  ensureThumbnail,
  ensureThumbnails,
  renditionQuality,
  renditionSize,
  thumbPath,
  type ThumbRequest
} from './thumbnails'
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

  it('serves the zoom tier from the wall file when the source is too small', () => {
    // `withoutEnlargement` means a 300x200 source encodes to 300x200 at both
    // tiers: the same pixels twice. Measured: 200 B for wall, 192 B for zoom.
    const small: ThumbRequest = { ...request('zoom'), sourceWidth: 300, sourceHeight: 200 }
    expect(thumbPath(cacheDir, small)).toBe(
      thumbPath(cacheDir, { ...request('wall'), sourceWidth: 300, sourceHeight: 200 })
    )
  })

  it('keeps a separate zoom file when the source is large enough to fill it', () => {
    const large: ThumbRequest = { ...request('zoom'), sourceWidth: 6000, sourceHeight: 4000 }
    expect(thumbPath(cacheDir, large)).toMatch(/-zoom\.webp$/)
    expect(thumbPath(cacheDir, large)).not.toBe(
      thumbPath(cacheDir, { ...request('wall'), sourceWidth: 6000, sourceHeight: 4000 })
    )
  })

  it('keeps the zoom tier when the source size is unknown', () => {
    // Missing dimensions are a scan that could not read them. Generating a
    // possibly-redundant file costs disk; skipping a needed one leaves the tile
    // permanently soft, which is the worse failure.
    expect(thumbPath(cacheDir, request('zoom'))).toMatch(/-zoom\.webp$/)
  })

  it('gives a display-sized rendition its own cache entry', () => {
    // The viewer asks for the size it will paint; that file must never be
    // confused with the 2560 `zoom` file the photo wall uses.
    const sized: ThumbRequest = { ...request('zoom'), maxEdge: 2048, sourceWidth: 8064, sourceHeight: 6048 }
    expect(thumbPath(cacheDir, sized)).toMatch(/-viewer2048\.webp$/)
    expect(thumbPath(cacheDir, sized)).not.toBe(
      thumbPath(cacheDir, { ...request('zoom'), sourceWidth: 8064, sourceHeight: 6048 })
    )
  })

  it('records the requested edge in the size and quality it reports', () => {
    const sized: ThumbRequest = { ...request('zoom'), maxEdge: 2048, sourceWidth: 8064, sourceHeight: 6048 }
    expect(renditionSize(sized)).toBe(2048)
    expect(renditionQuality(sized)).toBe(VIEWER_QUALITY)
    // The fixed tiers keep their own values.
    expect(renditionSize(request('zoom'))).toBe(THUMB_SIZES.zoom)
    expect(renditionQuality(request('zoom'))).toBe(THUMB_QUALITY.zoom)
  })

  it('shares the wall file for a small source even when a size is given', () => {
    // A 300px source cannot fill any rendition, so a display-sized request is
    // the same file the wall already has.
    const tinyWall: ThumbRequest = { ...request('wall'), sourceWidth: 300, sourceHeight: 200 }
    const tinySized: ThumbRequest = { ...request('zoom'), maxEdge: 2048, sourceWidth: 300, sourceHeight: 200 }
    expect(thumbPath(cacheDir, tinySized)).toBe(thumbPath(cacheDir, tinyWall))
    expect(renditionSize(tinySized)).toBe(THUMB_SIZES.wall)
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

  it('writes only one file for a source smaller than the wall tier', async () => {
    // The saving this is for: a small photo used to cost two encodes and two
    // files for one set of pixels. Asking for both tiers must now leave a single
    // file on disk, and both requests must resolve to it.
    await makeSource(300, 200)
    const dims = { sourceWidth: 300, sourceHeight: 200 }

    const wall = await ensureThumbnail(cacheDir, { ...request('wall'), ...dims })
    const zoom = await ensureThumbnail(cacheDir, { ...request('zoom'), ...dims })

    expect(zoom).toBe(wall)
    const files = await allFiles(cacheDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-wall\.webp$/)
  })

  it('still writes both tiers for a source that can fill them', async () => {
    const dims = { sourceWidth: 1200, sourceHeight: 800 }
    const wall = await ensureThumbnail(cacheDir, { ...request('wall'), ...dims })
    const zoom = await ensureThumbnail(cacheDir, { ...request('zoom'), ...dims })

    expect(zoom).not.toBe(wall)
    expect(await allFiles(cacheDir)).toHaveLength(2)
    // And the zoom file really is bigger, so the second tier is not pure waste.
    expect((await stat(zoom)).size).toBeGreaterThan((await stat(wall)).size)
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
    const files = await allFiles(cacheDir)
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
    const files = await allFiles(cacheDir)
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

    const files = await allFiles(cacheDir)
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
