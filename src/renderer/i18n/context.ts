import { createContext, useContext } from 'react'
import type { MessageKey, MessageParams } from '@shared/i18n/messages'
import type { LocaleDefinition, Translator } from '@shared/i18n'

/**
 * React binding for the framework-free i18n core in `@shared/i18n`.
 *
 * The provider value is a `Translator` plus the list of selectable locales, so
 * components never reach into module state. That keeps `render()` in tests free
 * of global setup: pass any translator and the component renders in that
 * language.
 */
export interface I18nContextValue {
  /** Resolved BCP-47 tag, e.g. `zh-CN`. */
  locale: string
  /** Every locale the picker offers. */
  available: readonly LocaleDefinition[]
  t: Translator['t']
  /** Select and persist a language. */
  setLocale: (locale: string) => void
}

/**
 * English defaults so a component rendered outside a provider (an isolated
 * story, a smoke test) still produces readable text instead of crashing.
 */
export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  available: [],
  t: (key: MessageKey, params?: MessageParams) => {
    void params
    return key
  },
  setLocale: () => {}
})

/** Read the active translator. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/** Convenience hook for components that only need strings. */
export function useT(): Translator['t'] {
  return useContext(I18nContext).t
}
