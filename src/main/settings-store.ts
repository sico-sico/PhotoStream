import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

/**
 * Settings persistence.
 *
 * The portable build keeps everything next to the executable, so there is no
 * installer, no registry writes and no `%APPDATA%` residue to clean up.
 * Writes go through a temporary file + rename so an interrupted save cannot
 * leave a truncated JSON file behind.
 */
export const SETTINGS_FILE = 'settings.json'

export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE)
}

/** Merge unknown JSON into the shape the app expects, dropping anything invalid. */
export function sanitizeSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Partial<Settings>
  const filters = (source.filters ?? {}) as Partial<Settings['filters']>
  const layout = source.layout
  const sort = source.sort

  return {
    lastDir: typeof source.lastDir === 'string' ? source.lastDir : DEFAULT_SETTINGS.lastDir,
    layout: layout === 'grid' || layout === 'masonry' || layout === 'square' ? layout : DEFAULT_SETTINGS.layout,
    sort:
      sort === 'taken-desc' || sort === 'taken-asc' || sort === 'name-asc' || sort === 'name-desc'
        ? sort
        : DEFAULT_SETTINGS.sort,
    filters: {
      from: typeof filters.from === 'string' ? filters.from : '',
      to: typeof filters.to === 'string' ? filters.to : '',
      text: typeof filters.text === 'string' ? filters.text : ''
    },
    // Kept as-is rather than validated against the bundled list: a settings file
    // written by a build that shipped an extra language must not be silently
    // reset when opened by a build that does not.
    locale: typeof source.locale === 'string' ? source.locale : DEFAULT_SETTINGS.locale
  }
}

/**
 * Strip a leading UTF-8 byte order mark.
 *
 * `JSON.parse` rejects `\uFEFF`, and Windows editors add a BOM freely: Notepad
 * writes one by default, and so does PowerShell's `Set-Content -Encoding utf8`.
 * A user who edits `settings.json` by hand would otherwise lose every setting on
 * the next launch, with no error shown anywhere.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function loadSettings(dataDir: string): Promise<Settings> {
  try {
    const text = await readFile(settingsPath(dataDir), 'utf-8')
    return sanitizeSettings(JSON.parse(stripBom(text)))
  } catch {
    // Missing on first run, unreadable, or genuinely malformed: start from
    // defaults rather than fail to launch.
    return { ...DEFAULT_SETTINGS, filters: { ...DEFAULT_SETTINGS.filters } }
  }
}

export async function saveSettings(dataDir: string, settings: Settings): Promise<Settings> {
  const safe = sanitizeSettings(settings)
  const target = settingsPath(dataDir)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  await writeFile(temp, JSON.stringify(safe, null, 2), 'utf-8')
  await rename(temp, target)
  return safe
}
