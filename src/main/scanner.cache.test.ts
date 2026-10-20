import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { scanDirectory } from './scanner'
import { MetadataCache } from './metadata-cache'

/**
 * The scan's cache path, with the file parser mocked out.
 *
 * What is under test is not the parse (covered by `metadata.test.ts`) but how
 * many times the scan calls it: a folder the cache already knows must be opened
 * zero times, and the writes must leave through `storeMany` rather than one
 * transaction per photo.
 */
const { readImageMetadata } = vi.hoisted(() => ({
  readImageMetadata: vi.fn(async () => ({
    width: 40,
    height: 20,
    takenAt: '2021-07-04',
    orientation: 1
  }))
}))

vi.mock('./metadata', () => ({ readImageMetadata }))

let dir = ''
let dbPath = ''
let cache: MetadataCache | null = null

async function writeJpeg(name: string): Promise<void> {
  // Contents do not matter: the parser is mocked.
  await writeFile(join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
}

beforeEach(async () => {
  readImageMetadata.mockClear()
  dir = await mkdtemp(join(tmpdir(), 'photostream-scan-cache-'))
  dbPath = join(dir, 'metadata.db')
  await writeJpeg('a.jpg')
  await writeJpeg('b.jpg')
})

afterEach(async () => {
  cache?.close()
  cache = null
  await rm(dir, { recursive: true, force: true })
})

describe('scanDirectory and the metadata cache', () => {
  it('parses each file once and answers the next scan from the cache', async () => {
    cache = new MetadataCache(dbPath)
    const cold = await scanDirectory(dir, { cache })
    expect(readImageMetadata).toHaveBeenCalledTimes(2)
    expect(cold.photos.map((photo) => photo.takenAt)).toEqual(['2021-07-04', '2021-07-04'])

    // A fresh handle, so nothing is answered from this process's memory.
    cache.close()
    cache = new MetadataCache(dbPath)
    const warm = await scanDirectory(dir, { cache })
    expect(readImageMetadata, 'a warm scan must not read the files').toHaveBeenCalledTimes(2)
    expect(warm.photos).toEqual(cold.photos)
  })

  it('re-reads a file whose mtime changed', async () => {
    cache = new MetadataCache(dbPath)
    await scanDirectory(dir, { cache })
    expect(readImageMetadata).toHaveBeenCalledTimes(2)

    // A re-export: same path, new bytes. `writeFile` moves the mtime.
    await writeJpeg('a.jpg')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeJpeg('a.jpg')

    await scanDirectory(dir, { cache })
    expect(readImageMetadata.mock.calls.length).toBeGreaterThan(2)
  })

  it('accepts an index read by the caller instead of querying again', async () => {
    cache = new MetadataCache(dbPath)
    await scanDirectory(dir, { cache })
    readImageMetadata.mockClear()

    const snapshot = cache.snapshot(dir)
    expect(snapshot.rows).toHaveLength(2)

    const scanned = await scanDirectory(dir, { cache, index: snapshot })
    expect(readImageMetadata).not.toHaveBeenCalled()
    expect(scanned.photos).toHaveLength(2)
  })

  it('drops rows for files that are gone', async () => {
    cache = new MetadataCache(dbPath)
    await scanDirectory(dir, { cache })
    await rm(join(dir, 'a.jpg'))

    await scanDirectory(dir, { cache })
    expect(cache.list(dir).map((row) => row.path)).toEqual([join(dir, 'b.jpg')])
  })
})
