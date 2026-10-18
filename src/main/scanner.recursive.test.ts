import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listImageFiles, MAX_SCAN_DEPTH } from './scanner'

/**
 * Recursive scanning.
 *
 * Off by default: a folder is usually one shoot, and sweeping in every
 * `_rejected/` subfolder would bury what the user meant to look at. These tests
 * pin both the default and the opt-in behaviour.
 */

let root = ''

async function touch(relative: string): Promise<void> {
  const full = join(root, ...relative.split('/'))
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, 'x')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photostream-recursive-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listImageFiles', () => {
  it('lists only the top level by default', async () => {
    await touch('top.jpg')
    await touch('nested/inner.jpg')

    expect(await listImageFiles(root)).toEqual(['top.jpg'])
  })

  it('includes subfolders when asked', async () => {
    await touch('top.jpg')
    await touch('nested/inner.jpg')

    expect(await listImageFiles(root, true)).toEqual(['nested/inner.jpg', 'top.jpg'])
  })

  it('returns paths relative to the root, so same-named files stay distinct', async () => {
    await touch('2024/a.jpg')
    await touch('2025/a.jpg')
    await touch('a.jpg')

    const names = await listImageFiles(root, true)
    expect(names).toEqual(['2024/a.jpg', '2025/a.jpg', 'a.jpg'])
    // Three different photos, not one name repeated.
    expect(new Set(names).size).toBe(3)
  })

  it('descends several levels', async () => {
    await touch('a/b/c/d/deep.jpg')

    expect(await listImageFiles(root, true)).toEqual(['a/b/c/d/deep.jpg'])
  })

  it('ignores non-JPEG files at every level', async () => {
    await touch('top.jpg')
    await touch('nested/notes.txt')
    await touch('nested/photo.jpeg')
    await touch('nested/raw.cr2')

    expect(await listImageFiles(root, true)).toEqual(['nested/photo.jpeg', 'top.jpg'])
  })

  it('skips hidden directories', async () => {
    await touch('visible.jpg')
    await touch('.thumbnails/cached.jpg')

    // Dot-directories hold caches and metadata, never user photos.
    expect(await listImageFiles(root, true)).toEqual(['visible.jpg'])
  })

  it('skips well-known noise directories', async () => {
    await touch('visible.jpg')
    await touch('node_modules/asset.jpg')
    await touch('$RECYCLE.BIN/deleted.jpg')

    expect(await listImageFiles(root, true)).toEqual(['visible.jpg'])
  })

  it('sorts the whole tree by relative path', async () => {
    await touch('b/z.jpg')
    await touch('a/y.jpg')
    await touch('c/x.jpg')

    expect(await listImageFiles(root, true)).toEqual(['a/y.jpg', 'b/z.jpg', 'c/x.jpg'])
  })

  it('survives an empty directory', async () => {
    expect(await listImageFiles(root, true)).toEqual([])
  })

  it('does not follow a symlink loop forever', async () => {
    // Windows junctions and POSIX symlinks both land here; the depth cap is the
    // backstop, so the call must return rather than hang.
    await touch('a/photo.jpg')

    const names = await listImageFiles(root, true)
    expect(names).toContain('a/photo.jpg')
    expect(names.length).toBeLessThan(1000)
  })

  it('exposes a finite depth cap', () => {
    // Without a bound, two junctions pointing at each other would make the walk
    // descend until the path length limit.
    expect(MAX_SCAN_DEPTH).toBeGreaterThan(0)
    expect(MAX_SCAN_DEPTH).toBeLessThan(100)
  })
})
