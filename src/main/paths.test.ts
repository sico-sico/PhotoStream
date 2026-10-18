import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR_NAME, baseDirectory, resolveDataDir, resolveThumbCacheDir } from './paths'

/**
 * `paths.ts` imports `electron` at module scope, but the functions under test
 * are pure. A minimal stub lets them run in plain Node without booting Electron.
 */

describe('baseDirectory', () => {
  it('uses userData in development so the repo stays clean', () => {
    const result = baseDirectory({ packaged: false, exePath: 'D:\\app\\PhotoStream.exe', userData: 'C:\\data' })
    expect(result).toBe('C:\\data')
  })

  it('uses the executable directory for a packaged build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photostream-exe-'))
    try {
      const exePath = join(dir, 'PhotoStream.exe')
      expect(baseDirectory({ packaged: true, exePath, userData: 'C:\\data' })).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to userData when the executable directory is gone', () => {
    // Happens when running from a removed removable drive or a mounted image.
    const result = baseDirectory({
      packaged: true,
      exePath: 'Z:\\nonexistent\\PhotoStream.exe',
      userData: 'C:\\data'
    })
    expect(result).toBe('C:\\data')
  })
})

describe('resolveDataDir', () => {
  it('appends the portable data directory name', () => {
    const result = resolveDataDir({ packaged: false, exePath: '/x', userData: '/data' })
    expect(result).toBe(join('/data', DATA_DIR_NAME))
  })

  it('keeps everything next to the executable when packaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photostream-exe-'))
    try {
      const result = resolveDataDir({ packaged: true, exePath: join(dir, 'app.exe'), userData: '/data' })
      expect(result).toBe(join(dir, DATA_DIR_NAME))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveThumbCacheDir', () => {
  it('nests the cache inside the data directory', () => {
    expect(resolveThumbCacheDir('/data/PhotoStreamData')).toBe(join('/data/PhotoStreamData', 'thumbs'))
  })
})
