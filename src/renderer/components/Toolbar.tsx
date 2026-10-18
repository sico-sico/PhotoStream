import type { LayoutMode, SortMode } from '@shared/types'
import type { MessageKey } from '@shared/i18n/messages'
import { useI18n } from '../i18n/context'
import { HistoryMenu } from './HistoryMenu'
import { Logo } from './Logo'
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
  /** Recent folders, newest first. */
  history: readonly string[]
  /** Whether subfolder JPEGs are included. */
  recursive: boolean
  onRecursiveChange: (recursive: boolean) => void
  onChooseFolder: () => void
  onOpenHistory: (dir: string) => void
  onRemoveHistory: (dir: string) => void
  onClearHistory: () => void
  onLayoutChange: (layout: LayoutMode) => void
  onSortChange: (sort: SortMode) => void
  onToggleFilters: () => void
  onAbout: () => void
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
  history,
  recursive,
  onRecursiveChange,
  onChooseFolder,
  onOpenHistory,
  onRemoveHistory,
  onClearHistory,
  onLayoutChange,
  onSortChange,
  onToggleFilters,
  onAbout
}: ToolbarProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <header className="toolbar">
      <Logo />

      <div className="toolbar-open">
        <button
          type="button"
          className="button primary toolbar-open-main"
          // The button is the discoverable action; the drop gesture has no
          // affordance of its own, so it is advertised here.
          title={t('toolbar.openFolderHint')}
          onClick={onChooseFolder}
        >
          {t('toolbar.openFolder')}
        </button>
        {/*
         * The caret only appears once there is something behind it; a history
         * control that opens an empty list is worse than no control at all.
         */}
        <HistoryMenu
          history={history}
          current={dir}
          onOpen={onOpenHistory}
          onRemove={onRemoveHistory}
          onClear={onClearHistory}
        />
      </div>

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
        {(close) => (
          <SettingsMenuContent
            onDone={close}
            onAbout={onAbout}
            recursive={recursive}
            onRecursiveChange={onRecursiveChange}
          />
        )}
      </Menu>

      <WindowControls />
    </header>
  )
}

/**
 * A gear, drawn as a path so it needs no icon font or extra asset.
 *
 * The previous version was a circle with eight straight lines radiating out of
 * it — which is the conventional drawing of a *sun*, not a cog: a gear's teeth
 * are notches cut into its rim, not spikes away from it. This is a real gear
 * silhouette: eight trapezoidal teeth on a 5.5/7.2 radius rim, plus a bore.
 *
 * It is filled rather than stroked. At the 15 px the toolbar renders, a 1.4 px
 * outline around sixteen tooth edges closes up into a grey blob; a solid shape
 * with a hole keeps the teeth legible. Both subpaths are in one `<path>` with
 * `evenodd`, so the bore is a genuine hole and the icon works over any
 * background instead of faking it with a background-coloured circle.
 *
 * Coordinates are generated, not hand-written, so the teeth stay even. The
 * generator's parameters are quoted so the shape can be retuned without
 * reverse-engineering the path:
 *   centre 8,8 · teeth 8 · tip radius 7.2 · root radius 5.5 · half-tooth 0.22 rad
 */
function GearIcon(): React.JSX.Element {
  return (
    <svg className="menu-icon menu-icon-solid" viewBox="0 0 16 16" aria-hidden="true">
      {/* One path with two subpaths: `evenodd` makes the bore a real hole.
          Splitting them into separate paths would fill the bore instead. */}
      <path
        fillRule="evenodd"
        d="M13.16 6.10L15.03 6.43L15.03 9.57L13.16 9.90L12.99 10.31L14.08 11.86L11.86 14.08L10.31 12.99L9.90 13.16L9.57 15.03L6.43 15.03L6.10 13.16L5.69 12.99L4.14 14.08L1.92 11.86L3.01 10.31L2.84 9.90L0.97 9.57L0.97 6.43L2.84 6.10L3.01 5.69L1.92 4.14L4.14 1.92L5.69 3.01L6.10 2.84L6.43 0.97L9.57 0.97L9.90 2.84L10.31 3.01L11.86 1.92L14.08 4.14L12.99 5.69Z M8 5.9A2.1 2.1 0 1 0 8 10.1A2.1 2.1 0 1 0 8 5.9Z"
      />
    </svg>
  )
}
