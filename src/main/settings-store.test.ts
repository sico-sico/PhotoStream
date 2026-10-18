import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/types'
import { SETTINGS_FILE, loadSettings, sanitizeSettings, saveSettings, settingsPath, stripBom } from './settings-store'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photostream-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('settingsPath', () => {
  it('lives directly in the data directory', () => {
    expect(settingsPath('/data')).toBe(join('/data', SETTINGS_FILE))
  })
})

describe('sanitizeSettings', () => {
  it('keeps a fully valid object', () => {
    const value = { lastDir: '/photos', layout: 'masonry' as const, filters: { from: '2020-01-01', to: '', text: 'x' }, locale: 'fr' }
    expect(sanitizeSettings(value)).toEqual(value)
  })

  it('falls back for an unknown layout', () => {
    expect(sanitizeSettings({ layout: 'spiral' }).layout).toBe(DEFAULT_SETTINGS.layout)
  })

  it('accepts every known layout', () => {
    for (const layout of ['grid', 'masonry', 'square'] as const) {
      expect(sanitizeSettings({ layout }).layout).toBe(layout)
    }
  })

  it('defaults missing fields', () => {
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
  })

  it('replaces non-string fields', () => {
    const result = sanitizeSettings({ lastDir: 42, layout: 'grid', filters: { from: null, to: 5, text: {} }, locale: 7 })
    expect(result.lastDir).toBe('')
    expect(result.filters).toEqual({ from: '', to: '', text: '' })
    expect(result.locale).toBe('')
  })

  it('preserves an unknown locale instead of resetting it', () => {
    // A settings file written by a build that shipped an extra language must
    // not be silently rewritten when opened by a build that does not.
    expect(sanitizeSettings({ locale: 'de' }).locale).toBe('de')
  })

  it('handles a partial filters object', () => {
    expect(sanitizeSettings({ filters: { text: 'kyoto' } }).filters).toEqual({ from: '', to: '', text: 'kyoto' })
  })
})

describe('loadSettings', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('reads a saved file', async () => {
    await writeFile(
      settingsPath(dir),
      JSON.stringify({ lastDir: '/photos', layout: 'square', filters: { from: '', to: '', text: '' }, locale: 'zh-CN' }),
      'utf-8'
    )
    const settings = await loadSettings(dir)
    expect(settings.lastDir).toBe('/photos')
    expect(settings.layout).toBe('square')
    expect(settings.locale).toBe('zh-CN')
  })

  it('recovers from malformed JSON', async () => {
    await writeFile(settingsPath(dir), '{ this is not json', 'utf-8')
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('reads a file that starts with a UTF-8 BOM', async () => {
    // Windows editors add a BOM freely (Notepad and PowerShell both do), and
    // `JSON.parse` rejects it. Without stripping, editing the file by hand
    // silently resets every setting on the next launch.
    const body = JSON.stringify({ lastDir: '/bom', layout: 'square', filters: { from: '', to: '', text: '' }, locale: 'fr' })
    await writeFile(settingsPath(dir), `\uFEFF${body}`, 'utf-8')

    const settings = await loadSettings(dir)
    expect(settings.lastDir).toBe('/bom')
    expect(settings.layout).toBe('square')
    expect(settings.locale).toBe('fr')
  })

  it('stripBom removes only a leading BOM', () => {
    expect(stripBom('\uFEFF{}')).toBe('{}')
    expect(stripBom('{}')).toBe('{}')
    expect(stripBom('\uFEFF')).toBe('')
    // A BOM inside the document must not be touched.
    expect(stripBom('{"a":"\uFEFF"}')).toBe('{"a":"\uFEFF"}')
  })

  it('recovers from a truncated file left by a crash', async () => {
    await writeFile(settingsPath(dir), '{"lastDir":"/pho', 'utf-8')
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('sanitises out-of-range values on read', async () => {
    await writeFile(settingsPath(dir), JSON.stringify({ layout: 'spiral' }), 'utf-8')
    expect((await loadSettings(dir)).layout).toBe(DEFAULT_SETTINGS.layout)
  })

  it('returns a fresh default object each time', async () => {
    const first = await loadSettings(dir)
    first.filters.text = 'mutated'
    const second = await loadSettings(dir)
    expect(second.filters.text).toBe('')
  })
})

describe('saveSettings', () => {
  it('writes valid JSON that round-trips', async () => {
    const settings = { lastDir: '/photos', layout: 'masonry' as const, filters: { from: '2020-01-01', to: '2020-12-31', text: 'kyoto' }, locale: 'fr' }
    await saveSettings(dir, settings)

    expect(JSON.parse(await readFile(settingsPath(dir), 'utf-8'))).toEqual(settings)
    expect(await loadSettings(dir)).toEqual(settings)
  })

  it('creates the data directory when missing', async () => {
    const nested = join(dir, 'a', 'b', 'c')
    await saveSettings(nested, DEFAULT_SETTINGS)
    expect(await loadSettings(nested)).toEqual(DEFAULT_SETTINGS)
  })

  it('sanitises before writing', async () => {
    await saveSettings(dir, { layout: 'nope' } as never)
    expect(JSON.parse(await readFile(settingsPath(dir), 'utf-8')).layout).toBe(DEFAULT_SETTINGS.layout)
  })

  it('leaves no temporary file behind', async () => {
    await saveSettings(dir, DEFAULT_SETTINGS)
    const content = await readFile(join(dir, SETTINGS_FILE), 'utf-8')
    expect(content).toContain('"layout"')
    // The temp file is renamed into place; a leftover means the rename failed.
    await expect(readFile(`${settingsPath(dir)}.tmp`, 'utf-8')).rejects.toThrow()
  })

  it('overwrites an existing file atomically', async () => {
    await mkdir(dir, { recursive: true })
    await saveSettings(dir, { ...DEFAULT_SETTINGS, lastDir: '/first' })
    await saveSettings(dir, { ...DEFAULT_SETTINGS, lastDir: '/second' })
    expect((await loadSettings(dir)).lastDir).toBe('/second')
  })

  it('returns the sanitised value rather than the raw input', async () => {
    const result = await saveSettings(dir, { layout: 'grid', lastDir: 1 } as never)
    expect(result.lastDir).toBe('')
  })
})
