import type { LocaleDefinition } from '../index'
import { en } from '../messages'
import { fr } from './fr'
import { zhCN } from './zh-CN'

/**
 * Languages bundled with the app.
 *
 * Adding one is a two-line change: create the catalogue next to this file and
 * append it here. Third parties can instead call `locales.register()`.
 */
export const BUILTIN_LOCALES: readonly LocaleDefinition[] = [
  { id: 'en', label: 'English', catalog: en },
  { id: 'zh-CN', label: '中文（简体）', catalog: zhCN },
  { id: 'fr', label: 'Français', catalog: fr }
]
