import type { Catalog, MessageKey, MessageParams } from './messages'
import { en } from './messages'
import { BUILTIN_LOCALES } from './locales'

/**
 * Localisation core.
 *
 * Deliberately framework-free: everything here is a pure function over plain
 * data, so language negotiation, fallback and placeholder substitution are
 * testable without mounting React or starting Electron.
 */

export interface LocaleDefinition {
  /** BCP-47 tag, e.g. `en`, `zh-CN`, `fr`. */
  readonly id: string
  /** Endonym shown in the language picker, e.g. `中文（简体）`. */
  readonly label: string
  readonly catalog: Catalog
}

/** Locale used when nothing else matches; every catalogue falls back to it. */
export const DEFAULT_LOCALE = 'en'

/** Canonicalise a tag: `zh-cn` -> `zh-CN`, `FR` -> `fr`, whitespace stripped. */
export function normalizeLocale(tag: string): string {
  const cleaned = tag.trim().replace(/_/g, '-')
  if (!cleaned) return ''
  return cleaned
    .split('-')
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toUpperCase()))
    .join('-')
}

/** The language subtag: `zh-CN` -> `zh`. */
export function languageOf(tag: string): string {
  return normalizeLocale(tag).split('-')[0] ?? ''
}

/**
 * Substitute `{placeholder}` markers.
 *
 * An unknown placeholder is left intact on purpose: a missing parameter is a
 * programming error, and leaving `{width}` visible in a screenshot or a test
 * failure is far easier to diagnose than silently rendering an empty string.
 */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Resolve the best available locale for an ordered list of preferences.
 *
 * Tries, in order: exact match, then the bare language (`fr-CA` -> `fr`), then
 * the default locale. Anything unrecognised is ignored rather than throwing, so
 * a system locale this build does not ship can never break startup.
 */
export function resolveLocale(requested: readonly string[], available: readonly string[], fallback = DEFAULT_LOCALE): string {
  const pool = available.length > 0 ? available : [fallback]
  const canonical = new Map(pool.map((id) => [normalizeLocale(id), id]))
  const fallbackId = canonical.get(normalizeLocale(fallback)) ?? pool[0]

  for (const raw of requested) {
    const tag = normalizeLocale(raw)
    if (!tag) continue

    const exact = canonical.get(tag)
    if (exact) return exact

    const language = languageOf(tag)
    if (!language) continue
    for (const [key, id] of canonical) {
      if (languageOf(key) === language) return id
    }
  }

  return fallbackId
}

/** A locale bound to its catalogue, ready to serve strings. */
export interface Translator {
  readonly locale: string
  t: (key: MessageKey, params?: MessageParams) => string
}

/**
 * Registry of available locales.
 *
 * A plain class rather than a module-level mutable map so tests (and embedding
 * apps) can create isolated instances instead of mutating global state.
 */
export class LocaleRegistry {
  private readonly definitions = new Map<string, LocaleDefinition>()

  constructor(initial: readonly LocaleDefinition[] = BUILTIN_LOCALES) {
    for (const definition of initial) this.register(definition)
  }

  /**
   * Add or replace a locale.
   *
   * This is the extension point for shipping a language PhotoStream does not
   * bundle: call it once at startup with a catalogue typed as `Catalog`, and the
   * locale shows up in the picker automatically.
   */
  register(definition: LocaleDefinition): void {
    const id = normalizeLocale(definition.id)
    if (!id) throw new Error('Locale id must not be empty')
    this.definitions.set(id, { ...definition, id })
  }

  unregister(id: string): boolean {
    return this.definitions.delete(normalizeLocale(id))
  }

  has(id: string): boolean {
    return this.definitions.has(normalizeLocale(id))
  }

  /** Registered locales, default first, then alphabetical by id. */
  list(): LocaleDefinition[] {
    return [...this.definitions.values()].sort((a, b) => {
      if (a.id === DEFAULT_LOCALE) return -1
      if (b.id === DEFAULT_LOCALE) return 1
      return a.id.localeCompare(b.id)
    })
  }

  ids(): string[] {
    return this.list().map((definition) => definition.id)
  }

  /** Resolve the tag that will actually be used for this set of preferences. */
  resolve(requested: readonly string[]): string {
    return resolveLocale(requested, this.ids(), DEFAULT_LOCALE)
  }

  /**
   * Build a translator. Unknown keys fall back to the English catalogue instead
   * of rendering the raw key, so a partially translated runtime locale degrades
   * gracefully.
   */
  translator(locale: string): Translator {
    const id = this.has(locale) ? normalizeLocale(locale) : this.resolve([locale])
    const catalog = this.definitions.get(id)?.catalog ?? en

    return {
      locale: id,
      t: (key, params) => formatMessage(catalog[key] ?? en[key] ?? key, params)
    }
  }
}

/** The app-wide registry, pre-populated with the bundled languages. */
export const locales = new LocaleRegistry()

/**
 * Format a `YYYY-MM-DD` capture date for display in a given locale.
 *
 * Built from `Date.UTC` and formatted with `timeZone: 'UTC'` on purpose:
 * constructing a local `Date` would shift the calendar day for users west of
 * Greenwich, which is exactly the class of bug that makes photo dates wrong.
 */
export function formatIsoDate(locale: string, iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso

  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(date.getTime())) return iso

  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC'
    }).format(date)
  } catch {
    // Intl rejects malformed tags; the raw ISO value is still useful.
    return iso
  }
}
