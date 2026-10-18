import { useCallback, useEffect, useMemo, useState } from 'react'
import { locales } from '@shared/i18n'
import type { LocaleDefinition } from '@shared/i18n'
import { I18nContext, type I18nContextValue } from './context'

export interface I18nProviderProps {
  /** Persisted preference: a locale tag, or `''` to follow the system. */
  preference: string
  /** OS preference list, used when `preference` is empty. */
  systemLocales: readonly string[]
  onLocaleChange: (locale: string) => void
  children: React.ReactNode
}

/**
 * Resolves, applies and publishes the active language.
 *
 * Resolution happens in an effect rather than in render because the registry is
 * mutable: a host app may register an extra locale after this component mounts,
 * and the picker must reflect that.
 */
export function I18nProvider({
  preference,
  systemLocales,
  onLocaleChange,
  children
}: I18nProviderProps): React.JSX.Element {
  // Re-resolve whenever the registry may have gained a locale or the preference
  // changed. `available` is derived state we recompute from the registry itself.
  const [available, setAvailable] = useState<readonly LocaleDefinition[]>(() => locales.list())
  const [locale, setLocale] = useState<string>(() =>
    locales.resolve(preference ? [preference, ...systemLocales] : systemLocales)
  )

  useEffect(() => {
    // Picking up locales registered by an embedding host after mount.
    setAvailable(locales.list())
  }, [])

  useEffect(() => {
    // An explicit choice always wins; an empty preference means "follow the OS".
    const requested = preference ? [preference, ...systemLocales] : systemLocales
    setLocale(locales.resolve(requested))
  }, [preference, systemLocales])

  // Keep the document language in sync: it drives hyphenation, font fallback for
  // CJK, and screen-reader pronunciation.
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
  }, [locale])

  const setLocalePreference = useCallback(
    (next: string) => {
      // Re-registering a locale is allowed, but switching to one that does not
      // exist would leave the UI on a stale language, so guard it here.
      if (!locales.has(next)) return
      onLocaleChange(next)
      setLocale(locales.resolve([next]))
    },
    [onLocaleChange]
  )

  const value = useMemo<I18nContextValue>(() => {
    const translator = locales.translator(locale)
    return {
      locale: translator.locale,
      available,
      t: translator.t,
      setLocale: setLocalePreference
    }
  }, [locale, available, setLocalePreference])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
