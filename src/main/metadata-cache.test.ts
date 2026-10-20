import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

  it('drops rows written before dimensions were read correctly, once', () => {
    /*
     * Photos whose metadata ran past the first read window were stored as
     * 0 x 0 and laid out as squares. The rows are indistinguishable from a
     * legitimate "no dimensions" answer, so they are cleared wholesale on the
     * first start after the fix — and only then, since a second pass would
     * throw away every genuinely unmeasurable file on each launch.
     */
    cache = new MetadataCache(file())
    cache.store('/photos/zero.jpg', 1, 1, { ...sample, width: 0, height: 0 })
    cache.store('/photos/good.jpg', 1, 1, sample)
    cache.close()

    // A database written by the build before the fix: same schema, no marker.
    const db = new DatabaseSync(file())
    db.exec("DELETE FROM cache_info WHERE key = 'zero_dimension_repair'")
    db.close()

    cache = new MetadataCache(file())
    expect(cache.lookup('/photos/zero.jpg', 1, 1)).toBeUndefined()
    expect(cache.lookup('/photos/good.jpg', 1, 1)).toEqual(sample)

    cache.store('/photos/zero.jpg', 1, 1, { ...sample, width: 0, height: 0 })
    cache.close()

    cache = new MetadataCache(file())
    expect(cache.lookup('/photos/zero.jpg', 1, 1)?.takenAt, 'the repair does not run twice').toBe(
      '2020-01-01'
    )
  })

  it('forgets photos that are no longer in the folder', () => {
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1, 1, sample)
    cache.store('/photos/b.jpg', 1, 1, sample)
    cache.store('/photos/gone.jpg', 1, 1, sample)

    cache.retain('/photos', ['/photos/a.jpg', '/photos/b.jpg'])

    expect(cache.lookup('/photos/a.jpg', 1, 1)).toEqual(sample)
    expect(cache.lookup('/photos/gone.jpg', 1, 1)).toBeUndefined()
  })

  it('keeps other folders when one folder is retained', () => {
    // The cache is shared by every folder the user has ever opened, but
    // `retain` ran with only the folder that had just been scanned — so
    // switching folders wiped the other one. Measured with the history menu,
    // which exists precisely to switch back: reopening a 3226-photo library
    // took 1387 ms instead of 104 ms, because every row had been pruned the
    // moment a different folder was opened.
    cache = new MetadataCache(file())
    cache.store('/trip/a.jpg', 1, 1, sample)
    cache.store('/trip/b.jpg', 1, 1, sample)
    cache.store('/party/c.jpg', 1, 1, sample)

    cache.retain('/trip', ['/trip/a.jpg', '/trip/b.jpg'])

    expect(cache.lookup('/trip/a.jpg', 1, 1)).toEqual(sample)
    // A folder that is not part of this scan must survive: it was not deleted
    // from disk, it is just not the folder being scanned right now.
    expect(cache.lookup('/party/c.jpg', 1, 1)).toEqual(sample)
  })

  it('does nothing when asked to retain an empty list', () => {
    // An empty folder is a real state; wiping the cache on it would throw away
    // work for every photo that is merely outside the current scan.
    cache = new MetadataCache(file())
    cache.store('/photos/a.jpg', 1, 1, sample)
    cache.retain('/photos', [])
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
    expect(() => cache!.retain('/p', ['/p/a.jpg'])).not.toThrow()
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

  describe('full EXIF', () => {
    const exif = { make: 'SONY', model: 'ILCE-7M5', fNumber: 1.8, iso: 100 }

    it('misses until the panel has read the file', () => {
      // A scan stores the date but not the full EXIF; "not read yet" must be
      // distinguishable from "this photo has none", or the panel would render
      // an empty result instead of parsing.
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toEqual(sample)
      expect(cache.lookupExif('/photos/a.jpg', 1000, 5000)).toBeUndefined()
    })

    it('round-trips the full EXIF', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeExif('/photos/a.jpg', 1000, 5000, exif)
      expect(cache.lookupExif('/photos/a.jpg', 1000, 5000)).toEqual(exif)
    })

    it('keeps the scan fields intact when storing full EXIF', () => {
      // The two writes share a row, so a bad update would silently break the
      // wall's date ordering.
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeExif('/photos/a.jpg', 1000, 5000, exif)
      expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toEqual(sample)
    })

    it('survives a restart', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeExif('/photos/a.jpg', 1000, 5000, exif)
      cache.close()

      cache = new MetadataCache(file())
      expect(cache.lookupExif('/photos/a.jpg', 1000, 5000)).toEqual(exif)
    })

    it('rejects the full EXIF once the file changes', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeExif('/photos/a.jpg', 1000, 5000, exif)
      // A re-export shifts both mtime and size, so the stored settings describe
      // a file that no longer exists.
      expect(cache.lookupExif('/photos/a.jpg', 2000, 5000)).toBeUndefined()
      expect(cache.lookupExif('/photos/a.jpg', 1000, 6000)).toBeUndefined()
    })

    it('does not create a row for a photo the scan never saw', () => {
      // Inserting here would leave the row without a date, which the wall reads.
      cache = new MetadataCache(file())
      cache.storeExif('/photos/unknown.jpg', 1, 1, exif)
      expect(cache.lookup('/photos/unknown.jpg', 1, 1)).toBeUndefined()
      expect(cache.lookupExif('/photos/unknown.jpg', 1, 1)).toBeUndefined()
    })

    it('replaces stale EXIF when a file is re-parsed', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeExif('/photos/a.jpg', 1000, 5000, exif)

      const updated = { ...exif, iso: 3200 }
      cache.storeExif('/photos/a.jpg', 1000, 5000, updated)
      expect(cache.lookupExif('/photos/a.jpg', 1000, 5000)).toEqual(updated)
    })

    it('drops the full EXIF when the row is pruned', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1, 1, sample)
      cache.store('/photos/b.jpg', 1, 1, sample)
      cache.storeExif('/photos/a.jpg', 1, 1, exif)
      // Only b.jpg remains in the folder.
      cache.retain('/photos', ['/photos/b.jpg'])
      expect(cache.lookupExif('/photos/a.jpg', 1, 1)).toBeUndefined()
      expect(cache.lookup('/photos/a.jpg', 1, 1)).toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns the rows of one folder, filesystem untouched', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.store('/photos/b.jpg', 2000, 6000, { ...sample, takenAt: '2021-02-03' })

      expect(cache.list('/photos')).toEqual([
        { path: '/photos/a.jpg', mtimeMs: 1000, sizeBytes: 5000, width: 2400, height: 1600, takenAt: '2020-01-01', orientation: 1 },
        { path: '/photos/b.jpg', mtimeMs: 2000, sizeBytes: 6000, width: 2400, height: 1600, takenAt: '2021-02-03', orientation: 1 }
      ])
    })

    it('covers subfolders but not a sibling with a shared prefix', () => {
      // The prefix has to end at a separator, or `/photos2` would be scanned as
      // part of `/photos`.
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1, 1, sample)
      cache.store('/photos/2024/b.jpg', 1, 1, sample)
      cache.store('/photos2/c.jpg', 1, 1, sample)

      expect(cache.list('/photos').map((row) => row.path)).toEqual(['/photos/2024/b.jpg', '/photos/a.jpg'])
    })

    it('handles Windows paths and a trailing separator', () => {
      // The production database holds Windows paths; tests use `/`. Both have to
      // resolve to the same subtree walk.
      cache = new MetadataCache(file())
      cache.store('D:\\Photos\\a.jpg', 1, 1, sample)
      cache.store('D:\\Photos\\2024\\b.jpg', 1, 1, sample)
      cache.store('D:\\Photos2\\c.jpg', 1, 1, sample)

      expect(cache.list('D:\\Photos\\').map((row) => row.path)).toEqual([
        'D:\\Photos\\2024\\b.jpg',
        'D:\\Photos\\a.jpg'
      ])
    })

    it('returns nothing for a folder it has never seen', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1, 1, sample)
      expect(cache.list('/elsewhere')).toEqual([])
    })
  })

  describe('storeMany', () => {
    it('writes every row in one go', () => {
      cache = new MetadataCache(file())
      cache.storeMany([
        { path: '/photos/a.jpg', mtimeMs: 1000, sizeBytes: 5000, ...sample },
        { path: '/photos/b.jpg', mtimeMs: 2000, sizeBytes: 6000, ...sample, takenAt: '2021-02-03' }
      ])

      expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toEqual(sample)
      expect(cache.lookup('/photos/b.jpg', 2000, 6000)?.takenAt).toBe('2021-02-03')
    })

    it('replaces the row of a re-exported file', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.storeMany([{ path: '/photos/a.jpg', mtimeMs: 2000, sizeBytes: 6000, ...sample }])

      expect(cache.lookup('/photos/a.jpg', 1000, 5000)).toBeUndefined()
      expect(cache.lookup('/photos/a.jpg', 2000, 6000)).toEqual(sample)
    })

    it('accepts an empty batch', () => {
      cache = new MetadataCache(file())
      expect(() => cache!.storeMany([])).not.toThrow()
      expect(cache.list('/photos')).toEqual([])
    })
  })

  describe('snapshot', () => {
    it('answers by path, and only for the version it read', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)

      const snapshot = cache.snapshot('/photos')
      expect(snapshot.get('/photos/a.jpg', 1000, 5000)).toEqual(sample)
      // The same rules as `lookup`: a changed file is a miss.
      expect(snapshot.get('/photos/a.jpg', 2000, 5000)).toBeUndefined()
      expect(snapshot.get('/photos/a.jpg', 1000, 6000)).toBeUndefined()
      expect(snapshot.get('/photos/b.jpg', 1000, 5000)).toBeUndefined()
    })

    it('exposes the rows it read, so the wall can paint from them', () => {
      cache = new MetadataCache(file())
      cache.store('/photos/a.jpg', 1000, 5000, sample)
      cache.store('/photos/2024/b.jpg', 2000, 6000, sample)

      expect(cache.snapshot('/photos').rows.map((row) => row.path)).toEqual([
        '/photos/2024/b.jpg',
        '/photos/a.jpg'
      ])
    })

    it('is empty for a folder with nothing cached', () => {
      cache = new MetadataCache(file())
      const snapshot = cache.snapshot('/photos')
      expect(snapshot.rows).toEqual([])
      expect(snapshot.get('/photos/a.jpg', 1, 1)).toBeUndefined()
    })
  })
})
