import { useEffect, useId, useRef, useState } from 'react'
import { folderName } from '@shared/history'
import { useI18n } from '../i18n/context'

export interface HistoryMenuProps {
  /** Remembered folders, most recent first. */
  history: readonly string[]
  /** The folder currently open, highlighted in the list. */
  current: string
  onOpen: (dir: string) => void
  onRemove: (dir: string) => void
  onClear: () => void
}

/**
 * Dropdown of recently opened folders, anchored under the "Open folder" button.
 *
 * Written by hand for the same reason as `Menu`: it is one popup, and a listbox
 * library would be a dependency for a `div` and a dozen lines of keyboard
 * handling.
 *
 * Rendered only when there is at least one entry — an empty history is not a
 * disabled control worth showing, it is simply not there yet.
 */
export function HistoryMenu({ history, current, onOpen, onRemove, onClear }: HistoryMenuProps): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelId = useId()

  const close = (): void => {
    setOpen(false)
    // Returning focus to the trigger keeps Tab from restarting at the top.
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Swallow it: the wall behind also listens for Escape.
      event.stopPropagation()
      close()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // Nothing to offer yet: hide the trigger rather than show a dead control.
  if (history.length === 0) return <></>

  return (
    <div className="history" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="button primary history-trigger"
        aria-label={t('history.show')}
        title={t('history.show')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="history-caret" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>

      {open ? (
        <div className="menu-panel history-panel" id={panelId} role="group" aria-label={t('history.show')}>
          <div className="history-heading">{t('history.title')}</div>
          <ul className="history-list">
            {history.map((dir) => {
              const isCurrent = dir === current
              return (
                <li key={dir} className={`history-item ${isCurrent ? 'current' : ''}`}>
                  <button
                    type="button"
                    className="history-open"
                    // The full path is the tooltip; the row shows the last segment.
                    title={dir}
                    dir="auto"
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => {
                      close()
                      onOpen(dir)
                    }}
                  >
                    <span className="history-name">{folderName(dir)}</span>
                    <span className="history-path" dir="auto">
                      {dir}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="history-remove"
                    aria-label={t('history.remove', { name: folderName(dir) })}
                    title={t('history.remove', { name: folderName(dir) })}
                    onClick={() => onRemove(dir)}
                  >
                    <svg viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
          <button type="button" className="button ghost history-clear" onClick={onClear}>
            {t('history.clear')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
