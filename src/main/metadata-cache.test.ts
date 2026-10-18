import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetadataCache } from './metadata-cache'

/**
 * The metadata cache.
 *
 * Reading EXIF costs a 512 KB prefix per photo: 1178 ms of the 1296 ms it took
 * to open a 3226-photo folder, against ~6 ms for the same answers out of SQLite.
 * These tests cover the two properties that make it safe to rely on: a row is
 * only returned for the exact file version it was written for, and a broken
 * database degrades to no cache rather than breaking the scan.
 */

let dir: string
let cache: MetadataCache | null = null

const sample = { width: 2400, height: 1600, takenAt: '2020-01-01', orientation: 1 }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdcache-test-'))
})

afterEach(async () => {
  cache?.close()
  cache = null
  await rm(dir, { recursive: true, force: true })
})

const file = (): string => join(dir, 'metadata.db')

describe('MetadataCache', () => {
  it('returns a stored entry for the same file version', () => {
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1000, 5000, sample)
    expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toEqual(sample)
  })

  it('misses when the file changed', () => {
    // A re-export in Lightroom keeps the path but changes mtime and size; a
    // stale row must never be served for it.
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1000, 5000, sample)

    expect(cache.lookup('/photos/a.jpg', 2000, 5000)).toBeUndefined()
    expect(cache.lookup('/photos/a.jpg', 1000, 6000)).toBeUndefined()
  })

  it('misses for an unknown path', () => {
    cache = new MetadataCache(file())
    expect(cache.lookup('/photos/missing.jpg', 1, 1)).toBeUndefined()
  })

  it('keeps entries across a reopen', () => {
    // The whole point: the answer has to survive a process restart.
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1000, 5000, sample)
    cache.close()

    cache = new MetadataCache(file())
    expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toEqual(sample)
  })

  it('replaces an entry when the same file changes', () => {
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1000, 5000, sample)
    const updated = { ...sample, width: 3000, takenAt: '2021-06-01' }
    cache.store('/photos/a.jpg', 2000, 6000, updated)

    expect(cache.lookup('/photos/a.jpg', 2000, 6000)).toEqual(updated)
    expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toBeUndefined()
  })

  it('stores an undated photo as such', () => {
    // A missing date is a real answer, not a cache miss.
    cache = new MetadataCache(file())
    const undated = { ...sample, takenAt: '' }
    cache.store('/photos/a.jpg', 1000, 5000, undated)
    expect(cache.lookup('/photos/a.jpg', 1000, 5000)?.takenAt).toBe('')
  })

  it('forgets photos that are no longer in the folder', () => {
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1, 1, sample)
    cache.store('/photos/b.jpg', 1, 1, sample)
    cache.store('/photos/gone.jpg', 1, 1, sample)

    cache.retain(['/photos/a.jpg', '/photos/b.jpg'])

    expect(cache.lookup('/photos/a.jpg', 1, 1)).toEqual(sample)
    expect(cache.lookup('/photos/gone.jpg', 1, 1)).toBeUndefined()
  })

  it('does nothing when asked to retain an empty list', () => {
    // An empty folder is a real state; wiping the whole cache on it would throw
    // away work for every other folder the user returns to.
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1, 1, sample)
    cache.retain([])
    expect(cache.lookup('/photos/a.jpg', 1, 1)).toEqual(sample)
  })

  it('creates the directory it needs', async () => {
    const nested = join(dir, 'a', 'b', 'c', 'metadata.db')
    cache = new MetadataCache(nested)
    cache.store('/photos/a.jpg', 1, 1, sample)
    expect(cache.lookup('/photos/a.jpg', 1, 1)).toEqual(sample)
    await expect(stat(nested)).resolves.toBeTruthy()
  })

  it('survives a path that cannot be opened, degrading to no cache', async () => {
    // A cache is an optimisation: an unusable file must not stop a scan. SQLite
    // happily creates a database under any file name, so the failure is forced
    // by pointing at a directory that already exists as a *file*.
    const blocker = join(dir, 'blocked')
    await writeFile(blocker, 'not a directory', 'utf-8')

    cache = new MetadataCache(join(blocker, 'metadata.db'))
    expect(() => cache!.store('/p/a.jpg', 1, 1, sample)).not.toThrow()
    expect(cache.lookup('/p/a.jpg', 1, 1)).toBeUndefined()
    expect(() => cache!.retain(['/p/a.jpg'])).not.toThrow()
    expect(() => cache!.close()).not.toThrow()
  })

  it('tolerates closing twice', () => {
    cache = new MetadataCache(file())
    cache.close()
    expect(() => cache!.close()).not.toThrow()
  })

  it('uses a 64-bit-safe size column', () => {
    // Camera files can exceed 2 GB; an INTEGER column must not truncate.
    cache = new MetadataCache(file())
    const huge = 3_500_000_000
    cache.store('/photos/big.jpg', 1, huge, sample)
    expect(cache.lookup('/photos/big.jpg', 1, huge)).toEqual(sample)
  })
})
