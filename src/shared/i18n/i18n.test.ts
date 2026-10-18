import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n/messages'
import { fr } from '@shared/i18n/locales/fr'
import { zhCN } from '@shared/i18n/locales/zh-CN'
import { BUILTIN_LOCALES } from '@shared/i18n/locales'
import {
  DEFAULT_LOCALE,
  LocaleRegistry,
  formatIsoDate,
  formatMessage,
  languageOf,
  locales,
  normalizeLocale,
  resolveLocale
} from '@shared/i18n'

describe('normalizeLocale', () => {
  it('lower-cases the language and canonicalises the region', () => {
    expect(normalizeLocale('zh-cn')).toBe('zh-CN')
    expect(normalizeLocale('ZH-HANS-CN')).toBe('zh-Hans-CN')
    expect(normalizeLocale('FR')).toBe('fr')
  })

  it('accepts underscores and surrounding whitespace', () => {
    expect(normalizeLocale('  zh_CN ')).toBe('zh-CN')
  })

  it('returns an empty string for blank input', () => {
    expect(normalizeLocale('')).toBe('')
    expect(normalizeLocale('   ')).toBe('')
  })
})

describe('languageOf', () => {
  it('keeps only the primary subtag', () => {
    expect(languageOf('zh-CN')).toBe('zh')
    expect(languageOf('fr-CA')).toBe('fr')
    expect(languageOf('en')).toBe('en')
  })
})

describe('formatMessage', () => {
  it('fills placeholders', () => {
    expect(formatMessage('{a} of {b}', { a: 1, b: 2 })).toBe('1 of 2')
  })

  it('leaves unknown placeholders visible instead of blanking them', () => {
    // A missing parameter is a bug; showing `{total}` makes it obvious.
    expect(formatMessage('{a} of {b}', { a: 1 })).toBe('1 of {b}')
  })

  it('returns the template untouched when no params are given', () => {
    expect(formatMessage('plain text')).toBe('plain text')
  })

  it('does not treat a lone brace as a placeholder', () => {
    expect(formatMessage('50% { of {a}', { a: 'x' })).toBe('50% { of x')
  })
})

describe('resolveLocale', () => {
  const available = ['en', 'zh-CN', 'fr']

  it('matches exactly', () => {
    expect(resolveLocale(['fr'], available)).toBe('fr')
    expect(resolveLocale(['zh-CN'], available)).toBe('zh-CN')
  })

  it('falls back to the same language when the region differs', () => {
    expect(resolveLocale(['fr-CA'], available)).toBe('fr')
    expect(resolveLocale(['zh-TW'], available)).toBe('zh-CN')
  })

  it('walks the preference list in order', () => {
    expect(resolveLocale(['de', 'fr'], available)).toBe('fr')
  })

  it('falls back to English for anything unknown', () => {
    expect(resolveLocale(['de-DE', 'ja'], available)).toBe(DEFAULT_LOCALE)
    expect(resolveLocale([], available)).toBe(DEFAULT_LOCALE)
  })

  it('uses the first available locale when English is not offered', () => {
    expect(resolveLocale(['de'], ['zh-CN', 'fr'])).toBe('zh-CN')
  })

  it('ignores blank entries', () => {
    expect(resolveLocale(['', '  ', 'fr'], available)).toBe('fr')
  })
})

describe('LocaleRegistry', () => {
  it('lists the bundled locales with English first', () => {
    const registry = new LocaleRegistry()
    expect(registry.ids()).toEqual(['en', 'fr', 'zh-CN'])
  })

  it('serves strings for each bundled locale', () => {
    const registry = new LocaleRegistry()
    expect(registry.translator('en').t('toolbar.filters')).toBe('Filters')
    expect(registry.translator('fr').t('toolbar.filters')).toBe('Filtres')
    expect(registry.translator('zh-CN').t('toolbar.filters')).toBe('筛选')
  })

  it('resolves an unknown locale to the default', () => {
    const registry = new LocaleRegistry()
    const translator = registry.translator('de')
    expect(translator.locale).toBe('en')
  })

  it('substitutes parameters through the translator', () => {
    const registry = new LocaleRegistry()
    expect(registry.translator('en').t('filters.summary', { visible: 3, total: 9 })).toBe('3 of 9 photos')
  })

  describe('extension point', () => {
    it('accepts an injected locale and exposes it to the picker', () => {
      const registry = new LocaleRegistry()
      // A host that ships its own language only needs a full catalogue.
      registry.register({ id: 'de', label: 'Deutsch', catalog: { ...en, 'toolbar.filters': 'Filter' } })

      expect(registry.has('de')).toBe(true)
      expect(registry.ids()).toContain('de')
      expect(registry.translator('de').t('toolbar.filters')).toBe('Filter')
    })

    it('normalises the id on registration', () => {
      const registry = new LocaleRegistry([])
      registry.register({ id: 'pt_BR', label: 'Português', catalog: en })
      expect(registry.has('pt-BR')).toBe(true)
      expect(registry.translator('pt-br').locale).toBe('pt-BR')
    })

    it('replaces a locale registered twice', () => {
      const registry = new LocaleRegistry()
      registry.register({ id: 'en', label: 'English (custom)', catalog: { ...en, 'toolbar.filters': 'Filter!' } })
      expect(registry.translator('en').t('toolbar.filters')).toBe('Filter!')
      expect(registry.ids().filter((id) => id === 'en')).toHaveLength(1)
    })

    it('rejects an empty id', () => {
      const registry = new LocaleRegistry()
      expect(() => registry.register({ id: '  ', label: 'x', catalog: en })).toThrow(/empty/i)
    })

    it('can unregister a locale', () => {
      const registry = new LocaleRegistry()
      expect(registry.unregister('fr')).toBe(true)
      expect(registry.has('fr')).toBe(false)
      expect(registry.unregister('fr')).toBe(false)
    })

    it('does not mutate the module-level registry in tests', () => {
      // Each LocaleRegistry is isolated, so a test cannot leak a locale into
      // another test through the shared instance.
      const isolated = new LocaleRegistry()
      isolated.register({ id: 'xx', label: 'X', catalog: en })
      expect(locales.has('xx')).toBe(false)
    })
  })
})

describe('bundled catalogues', () => {
  const catalogues = [
    { id: 'en', catalog: en },
    { id: 'zh-CN', catalog: zhCN },
    { id: 'fr', catalog: fr }
  ]

  it('covers every message key', () => {
    const keys = Object.keys(en).sort()
    for (const { id, catalog } of catalogues) {
      expect(Object.keys(catalog).sort(), `${id} is missing keys`).toEqual(keys)
    }
  })

  it('has no empty strings', () => {
    for (const { id, catalog } of catalogues) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${id}:${key} is empty`).not.toBe('')
      }
    }
  })

  it('uses the same placeholders in every translation', () => {
    const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const expected = placeholders(en[key])
      for (const { id, catalog } of catalogues) {
        expect(placeholders(catalog[key]), `${id}:${key} placeholders differ`).toEqual(expected)
      }
    }
  })

  it('exposes ids that match the registry', () => {
    expect(BUILTIN_LOCALES.map((locale) => locale.id).sort()).toEqual(['en', 'fr', 'zh-CN'])
    for (const locale of BUILTIN_LOCALES) {
      expect(locale.label.trim()).not.toBe('')
    }
  })
})

describe('formatIsoDate', () => {
  it('formats without shifting the day', () => {
    // The regression this guards: `new Date('2006-05-12')` is UTC midnight,
    // which renders as 2006-05-11 in any negative-offset timezone.
    const formatted = formatIsoDate('en', '2006-05-12')
    expect(formatted).toContain('2006')
    expect(formatted).toMatch(/05|May/)
    expect(formatted).toMatch(/12/)
    expect(formatted).not.toContain('11')
  })

  it('keeps the correct day for every bundled locale', () => {
    // en-GB and fr both render `11/03/2024`, so asserting that outputs merely
    // differ would be testing Intl's formatting table rather than our code.
    // What matters is that the day never shifts.
    for (const locale of ['en', 'en-GB', 'en-US', 'fr', 'zh-CN']) {
      const formatted = formatIsoDate(locale, '2024-03-11')
      expect(formatted, locale).toContain('11')
      expect(formatted, locale).toContain('2024')
      expect(formatted, locale).not.toContain('10')
    }
  })

  it('uses locale-specific ordering', () => {
    // en-US is month-first; most of the world is day-first.
    expect(formatIsoDate('en-US', '2024-03-11')).toMatch(/^03/)
    expect(formatIsoDate('en-GB', '2024-03-11')).toMatch(/^11/)
  })

  it('passes malformed input through unchanged', () => {
    expect(formatIsoDate('en', '')).toBe('')
    expect(formatIsoDate('en', 'not-a-date')).toBe('not-a-date')
    expect(formatIsoDate('en', '2024-3-1')).toBe('2024-3-1')
  })

  it('survives a malformed locale tag', () => {
    expect(formatIsoDate('!!!invalid', '2024-03-11')).toBe('2024-03-11')
  })
})
