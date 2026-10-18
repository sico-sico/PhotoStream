import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/context'

/**
 * Window controls for the frameless window.
 *
 * The native title bar only repeated the app name and the default Electron menu
 * had no commands behind it, so both are gone. These buttons replace the
 * minimise/maximise/close affordances the OS would normally draw.
 *
 * Dragging is handled by CSS `-webkit-app-region: drag` on the bar itself, with
 * `no-drag` on the buttons so they stay clickable.
 */
export function WindowControls(): React.JSX.Element {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.photoStream.isMaximized().then(setMaximized)
    return window.photoStream.onWindowState(setMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-button"
        aria-label={t('window.minimize')}
        title={t('window.minimize')}
        onClick={() => void window.photoStream.minimize()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6h8" />
        </svg>
      </button>

      <button
        type="button"
        className="window-button"
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
        title={maximized ? t('window.restore') : t('window.maximize')}
        onClick={() => void window.photoStream.toggleMaximize().then(setMaximized)}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1.5" y="3.5" width="7" height="7" />
            <path d="M3.5 3.5V1.5h7v7h-2" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="window-button close"
        aria-label={t('window.close')}
        title={t('window.close')}
        onClick={() => void window.photoStream.close()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
    </div>
  )
}
