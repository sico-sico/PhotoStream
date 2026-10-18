import type { LayoutMode } from '@shared/types'
import type { MessageKey } from '@shared/i18n/messages'
import { useI18n } from '../i18n/context'
import { LanguagePicker } from './LanguagePicker'
import { WindowControls } from './WindowControls'

export interface ToolbarProps {
  dir: string
  layout: LayoutMode
  filtersOpen: boolean
  busy: boolean
  visibleCount: number
  totalCount: number
  onChooseFolder: () => void
  onLayoutChange: (layout: LayoutMode) => void
  onToggleFilters: () => void
}

const LAYOUTS: ReadonlyArray<{ value: LayoutMode; label: MessageKey; hint: MessageKey }> = [
  { value: 'grid', label: 'toolbar.layoutGrid', hint: 'toolbar.layoutGridHint' },
  { value: 'masonry', label: 'toolbar.layoutMasonry', hint: 'toolbar.layoutMasonryHint' },
  { value: 'square', label: 'toolbar.layoutSquare', hint: 'toolbar.layoutSquareHint' }
]

export function Toolbar({
  dir,
  layout,
  filtersOpen,
  busy,
  visibleCount,
  totalCount,
  onChooseFolder,
  onLayoutChange,
  onToggleFilters
}: ToolbarProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <header className="toolbar">
      <button type="button" className="button primary" onClick={onChooseFolder}>
        {t('toolbar.openFolder')}
      </button>

      <div className="dir-label" title={dir} dir="auto">
        {busy ? t('toolbar.scanning') : dir || t('toolbar.noFolder')}
      </div>

      <div className="layout-switch" role="group" aria-label={t('toolbar.layoutAria')}>
        {LAYOUTS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`button chip ${layout === item.value ? 'active' : ''}`}
            title={t(item.hint)}
            aria-pressed={layout === item.value}
            onClick={() => onLayoutChange(item.value)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`button ghost ${filtersOpen ? 'active' : ''}`}
        aria-expanded={filtersOpen}
        onClick={onToggleFilters}
      >
        {t('toolbar.filters')}
      </button>

      {/**
       * The only counter in the UI.
       *
       * Thumbnail generation is now demand-driven (only what is on screen), so
       * a second `x/y` progress figure had no meaningful total and read as a
       * duplicate of this one.
       */}
      <div className="toolbar-stats">
        <span className="photo-count" title={t('toolbar.photoCount', { visible: visibleCount, total: totalCount })}>
          {visibleCount}/{totalCount}
        </span>
      </div>

      <LanguagePicker />
      <WindowControls />
    </header>
  )
}
