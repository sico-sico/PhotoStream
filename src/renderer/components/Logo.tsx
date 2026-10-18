import { useI18n } from '../i18n/context'

/**
 * The app mark, drawn inline as SVG.
 *
 * Inline rather than an `<img src>` so it inherits the theme variables and needs
 * no asset pipeline or extra file at runtime. This mark is the source of truth
 * for `build/icon.svg`, which is the same geometry and colours scaled by 16, so
 * the window/taskbar icon and this one stay the same mark; keep the two files in
 * sync. Two masonry columns with offset rows are the app's own layout rather
 * than a generic grid. The wordmark is dropped at this size (22 px) because the
 * columns already read as the app's identity.
 */
export function Logo(): React.JSX.Element {
  const { t } = useI18n()

  return (
    <div className="toolbar-logo" title={t('app.title')}>
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        {/* Rounded tile, matching the app icon's proportions at this scale. */}
        <rect className="logo-tile" x="0" y="0" width="32" height="32" rx="8" />
        {/* Masonry: the left column is taller than the right one, which is what
            distinguishes the mark from a plain window/grid icon. */}
        <rect className="logo-light" x="5" y="5" width="10" height="10" rx="2.2" />
        <rect className="logo-accent" x="5" y="17" width="10" height="10" rx="2.2" />
        <rect className="logo-mid" x="17" y="5" width="10" height="7" rx="2.2" />
        <rect className="logo-dim" x="17" y="14" width="10" height="13" rx="2.2" />
      </svg>
      <span className="toolbar-logo-word">{t('app.title')}</span>
    </div>
  )
}
