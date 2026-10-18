import type { LayoutMode, SortMode } from '@shared/types'
import type { MessageKey } from '@shared/i18n/messages'
import { useI18n } from '../i18n/context'
import { Menu } from './Menu'
import { SettingsMenuContent } from './SettingsMenuContent'
import { SortPicker } from './SortPicker'
import { WindowControls } from './WindowControls'

export interface ToolbarProps {
  dir: string
  layout: LayoutMode
  sort: SortMode
  filtersOpen: boolean
  busy: boolean
  visibleCount: number
  totalCount: number
  onChooseFolder: () => void
  onLayoutChange: (layout: LayoutMode) => void
  onSortChange: (sort: SortMode) => void
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
  sort,
  filtersOpen,
  busy,
  visibleCount,
  totalCount,
  onChooseFolder,
  onLayoutChange,
  onSortChange,
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

      <SortPicker sort={sort} onChange={onSortChange} />

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

      {/**
       * Preferences live behind the gear.
       *
       * They are set once and then left alone, so giving them permanent space
       * crowded out the controls used while browsing. The trigger is icon-only
       * for the same reason.
       */}
      <Menu label={t('toolbar.settings')} icon={<GearIcon />}>
        {(close) => <SettingsMenuContent onDone={close} />}
      </Menu>

      <WindowControls />
    </header>
  )
}

/** A gear, drawn as a path so it needs no icon font or extra asset. */
function GearIcon(): React.JSX.Element {
  return (
    <svg className="menu-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
    </svg>
  )
}
