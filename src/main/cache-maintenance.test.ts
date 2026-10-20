import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTECTED_AGE_MS,
  TEMP_MIN_AGE_MS,
  TRIM_TO_FRACTION,
  ThumbCache,
  classifyCacheFileName,
  sweepThumbCache
} from './cache-maintenance'

let cacheDir = ''

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A file in the `a/b/` shard shape the app actually writes. */
async function makeFile(name: string, size: number, ageMs: number, shard = 'a/b'): Promise<string> {
  const dir = join(cacheDir, shard)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc(size, 1))
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return path
}

async function allFiles(): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(entry.name)
    }
  }
  await walk(cacheDir)
  return out
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'photostream-cache-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

describe('classifyCacheFileName', () => {
  it('accepts every rendition this build can write', () => {
    expect(classifyCacheFileName('0123456789abcdef-wall512q78p1.webp')).toBe('current')
    expect(classifyCacheFileName('0123456789abcdef-wall842q78p1.webp')).toBe('current')
    expect(classifyCacheFileName('0123456789abcdef-zoom2560q82p1.webp')).toBe('current')
    expect(classifyCacheFileName('0123456789abcdef-viewer1792q85p1.webp')).toBe('current')
  })

  it('retires the pre-0.2.3 names', () => {
    // These are the files a user upgrading from 0.2.2 already has. Nothing reads
    // them again: `thumbKey` now hashes a different tag.
    expect(classifyCacheFileName('0123456789abcdef-wall.webp')).toBe('orphan')
    expect(classifyCacheFileName('0123456789abcdef-wall842.webp')).toBe('orphan')
    expect(classifyCacheFileName('0123456789abcdef-zoom.webp')).toBe('orphan')
    expect(classifyCacheFileName('0123456789abcdef-viewer2048.webp')).toBe('orphan')
  })

  it('retires a file encoded with other constants', () => {
    expect(classifyCacheFileName('0123456789abcdef-wall512q82p1.webp')).toBe('orphan')
    expect(classifyCacheFileName('0123456789abcdef-wall512q78p9.webp')).toBe('orphan')
  })

  it('recognises its own temporary files', () => {
    expect(classifyCacheFileName('0123456789abcdef-wall512q78p1.webp.412.1699.ab12cd.tmp')).toBe('temp')
  })

  it('keeps names it does not understand', () => {
    // The important half: an unrecognised file is never deleted. A future
    // version's file, a stray note or a Windows thumbnail database all survive.
    expect(classifyCacheFileName('Thumbs.db')).toBe('unknown')
    expect(classifyCacheFileName('README.txt')).toBe('unknown')
    expect(classifyCacheFileName('nothex-wall512q78p1.webp')).toBe('unknown')
    expect(classifyCacheFileName('0123456789abcdef-wall512q78p1.jpg')).toBe('unknown')
  })
})

describe('sweepThumbCache', () => {
  it('deletes old orphans and keeps current renditions', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp', 100, 2 * DAY, 'a/b')
    await makeFile('0123456789abcdef-wall.webp', 200, 2 * DAY, 'a/b')
    await makeFile('0123456789abcdef-viewer2048.webp', 300, 2 * DAY, 'c/d')

    const result = await sweepThumbCache(cacheDir)

    expect(result.removedFiles).toBe(2)
    expect(result.removedBytes).toBe(500)
    expect(await allFiles()).toEqual(['0123456789abcdef-wall512q78p1.webp'])
  })

  it('leaves young orphans alone', async () => {
    // A file written seconds ago may be one this session is still reading. The
    // renaming window alone is enough reason not to race the encoder.
    await makeFile('0123456789abcdef-wall.webp', 100, PROTECTED_AGE_MS - 1000)

    const result = await sweepThumbCache(cacheDir)

    expect(result.removedFiles).toBe(0)
    expect(await allFiles()).toHaveLength(1)
  })

  it('collects temporaries only once they are clearly stale', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp.1.2.abc.tmp', 10, TEMP_MIN_AGE_MS + HOUR)
    await makeFile('0123456789abcdef-wall512q78p1.webp.1.3.def.tmp', 10, 60_000)

    const result = await sweepThumbCache(cacheDir)

    expect(result.removedFiles).toBe(1)
    expect(await allFiles()).toHaveLength(1)
  })

  it('never deletes a file it does not recognise', async () => {
    await makeFile('Thumbs.db', 100, 30 * DAY)
    await makeFile('0123456789abcdef-wall.webp', 100, 30 * DAY)

    const result = await sweepThumbCache(cacheDir)

    expect(await allFiles()).toContain('Thumbs.db')
    expect(result.removedFiles).toBe(1)
  })

  it('counts what is left, including unreadable names', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp', 100, 2 * DAY)
    await makeFile('notes.txt', 50, 2 * DAY)

    const result = await sweepThumbCache(cacheDir)

    expect(result.files).toBe(2)
    expect(result.bytes).toBe(150)
  })

  it('does nothing to the budget when none is set', async () => {
    // `0` means "the user chose not to limit this": orphan collection still runs,
    // but a cache well over any sensible size is left intact.
    for (let i = 0; i < 5; i += 1) {
      await makeFile(`0123456789abcde${i}-wall512q78p1.webp`, 1000, 2 * DAY)
    }

    const result = await sweepThumbCache(cacheDir, { budgetBytes: 0 })

    expect(result.removedFiles).toBe(0)
  })

  it('evicts the oldest files down to the trim target', async () => {
    // Five 1000-byte files against a 3000-byte budget, trimmed to 90% (2700 B):
    // three have to go, oldest first, leaving 2000 B.
    for (let i = 0; i < 5; i += 1) {
      await makeFile(`0123456789abcde${i}-wall512q78p1.webp`, 1000, (5 - i) * DAY)
    }

    const result = await sweepThumbCache(cacheDir, { budgetBytes: 3000 })

    expect(result.files).toBe(2)
    expect(result.bytes).toBe(2000)
    expect(result.bytes).toBeLessThanOrEqual(3000 * TRIM_TO_FRACTION)
    expect(await allFiles()).not.toContain('0123456789abcde0-wall512q78p1.webp')
    expect(await allFiles()).not.toContain('0123456789abcde1-wall512q78p1.webp')
    expect(await allFiles()).not.toContain('0123456789abcde2-wall512q78p1.webp')
    expect(await allFiles()).toContain('0123456789abcde4-wall512q78p1.webp')
  })

  it('protects young files from eviction', async () => {
    await makeFile('0123456789abcde0-wall512q78p1.webp', 1000, 2 * DAY)
    await makeFile('0123456789abcde1-wall512q78p1.webp', 1000, 1000)

    const result = await sweepThumbCache(cacheDir, { budgetBytes: 1000 })

    // Only the old file may be evicted; the total can stay above the target
    // rather than delete something in use.
    expect(result.removedFiles).toBe(1)
    expect(await allFiles()).toEqual(['0123456789abcde1-wall512q78p1.webp'])
  })

  it('removes shard directories left empty', async () => {
    await makeFile('0123456789abcdef-wall.webp', 100, 2 * DAY, 'a/b')
    await makeFile('0123456789abcdef-wall.webp', 100, 2 * DAY, 'c/d')

    const result = await sweepThumbCache(cacheDir)

    expect(result.removedDirs).toBe(4) // a/b, a, c/d, c — deepest first
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('keeps a directory that still holds a current file', async () => {
    await makeFile('0123456789abcdef-wall.webp', 100, 2 * DAY, 'a/b')
    await makeFile('0123456789abcdef-wall512q78p1.webp', 100, 2 * DAY, 'a/b')

    const result = await sweepThumbCache(cacheDir)

    expect(result.removedDirs).toBe(0)
    expect(existsSync(join(cacheDir, 'a', 'b'))).toBe(true)
  })

  it('survives a cache directory that does not exist', async () => {
    const result = await sweepThumbCache(join(cacheDir, 'missing'))
    expect(result).toEqual({ bytes: 0, files: 0, removedFiles: 0, removedBytes: 0, removedDirs: 0 })
  })
})

describe('ThumbCache', () => {
  it('reports nothing until the first sweep finishes', () => {
    const cache = new ThumbCache(cacheDir)
    // Zero bytes would be a lie: the menu has to say "calculating" instead.
    expect(cache.stats()).toEqual({ bytes: 0, files: 0, ready: false })
  })

  it('publishes the size the sweep found', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp', 700, 2 * DAY)
    const cache = new ThumbCache(cacheDir)

    await cache.sweep({ force: true })

    expect(cache.stats()).toEqual({ bytes: 700, files: 1, ready: true })
  })

  it('counts renditions encoded after the sweep', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp', 700, 2 * DAY)
    const cache = new ThumbCache(cacheDir)
    await cache.sweep({ force: true })

    cache.noteWritten(300)

    expect(cache.stats().bytes).toBe(1000)
  })

  it('throttles the sweeps the budget triggers', async () => {
    const cache = new ThumbCache(cacheDir)
    await cache.sweep({ force: true })

    // `force` is only for startup; a budget-triggered call right after a sweep
    // has to be a no-op, or every encode would walk the whole cache.
    expect(await cache.sweep()).toBeNull()
  })

  it('sweeps immediately when the budget is lowered below current usage', async () => {
    await makeFile('0123456789abcdef-wall512q78p1.webp', 2000, 2 * DAY)
    const cache = new ThumbCache(cacheDir, 0)
    await cache.sweep({ force: true })
    expect(cache.stats().bytes).toBe(2000)

    cache.setBudget(1000)
    await cache.sweep()

    // `setBudget` already started a sweep; this call joins it.
    expect(cache.stats().bytes).toBe(0)
  })

  it('encodes do not sweep when there is no budget', async () => {
    const cache = new ThumbCache(cacheDir, 0)
    await cache.sweep({ force: true })
    cache.noteWritten(10_000_000)
    // Nothing to assert on disk; the point is that the total keeps growing
    // without triggering a walk.
    expect(cache.stats().bytes).toBe(10_000_000)
  })

  it('reports zero bytes as a real number rather than a missing one', async () => {
    const cache = new ThumbCache(cacheDir, 1024)
    await cache.sweep({ force: true })
    expect(cache.stats().ready).toBe(true)
    expect(cache.stats().bytes).toBe(0)
    // And a stat of the empty directory stays cheap.
    expect((await stat(cacheDir)).isDirectory()).toBe(true)
  })
})
