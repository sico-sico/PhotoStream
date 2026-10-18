import { useEffect, useId, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n/messages'
import type { SortMode } from '@shared/types'
import { useI18n } from '../i18n/context'

/**
 * Wall ordering picker.
 *
 * A native `<select>` was used here originally, and it was the one control in
 * the toolbar that ignored the app's styling: Chromium paints it with the host
 * platform's own button chrome, so it sat next to the hand-styled buttons
 * looking like a different application.
 *
 * This is now the same idiom as the rest of the bar: a trigger showing the
 * active ordering, and a panel listing all four with the current one ticked. The
 * rows are `menuitemradio`, which is what "choose exactly one" means to a screen
 * reader.
 */
const OPTIONS: ReadonlyArray<{ value: SortMode; label: MessageKey }> = [
  { value: 'taken-desc', label: 'toolbar.sortNewest' },
  { value: 'taken-asc', label: 'toolbar.sortOldest' },
  { value: 'name-asc', label: 'toolbar.sortNameAsc' },
  { value: 'name-desc', label: 'toolbar.sortNameDesc' }
]

export interface SortPickerProps {
  sort: SortMode
  onChange: (sort: SortMode) => void
}

export function SortPicker({ sort, onChange }: SortPickerProps): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelId = useId()

  const active = OPTIONS.find((option) => option.value === sort) ?? OPTIONS[0]

  const close = (): void => {
    setOpen(false)
    // Focus returns to the trigger, or Tab restarts from the top of the page.
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Swallow it: the wall behind listens for Escape too.
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

  return (
    <div className="sort-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="button ghost sort-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('toolbar.sort')}
        title={t('toolbar.sort')}
        onClick={() => setOpen((value) => !value)}
      >
        <SortIcon mode={sort} />
        {/* The active ordering is spelled out: an icon alone would not say
            whether "newest" means by date or by name. */}
        <span className="sort-trigger-label">{t(active.label)}</span>
        <svg className="sort-caret" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>

      {open ? (
        <div className="menu-panel sort-panel" id={panelId} role="menu" aria-label={t('toolbar.sort')}>
          {OPTIONS.map((option) => {
            const checked = option.value === sort
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`sort-option ${checked ? 'active' : ''}`}
                onClick={() => {
                  onChange(option.value)
                  close()
                }}
              >
                <SortOptionIcon mode={option.value} />
                <span>{t(option.label)}</span>
                {/* A tick marks the active row; the icon alone is too subtle. */}
                <svg className="sort-check" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.5l2.5 2.5 4.5-5" />
                </svg>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Direction of travel, so the trigger says which way the wall runs. */
function isDescending(mode: SortMode): boolean {
  return mode === 'taken-desc' || mode === 'name-desc'
}

function isByName(mode: SortMode): boolean {
  return mode === 'name-asc' || mode === 'name-desc'
}

/**
 * A clock for date ordering, an "A" for name ordering, with a small arrow
 * underneath pointing the way the list runs.
 */
function SortIcon({ mode }: { mode: SortMode }): React.JSX.Element {
  return (
    <svg className="sort-icon" viewBox="0 0 16 16" aria-hidden="true">
      {isByName(mode) ? (
        <path d="M2.5 3.5h4.5M2.5 7h3M11 3v7.5M9 8.7l2 2.1 2-2.1" />
      ) : (
        <>
          <circle cx="8" cy="6.2" r="4.2" />
          <path d="M8 3.9v2.4l1.7 1.1" />
        </>
      )}
      <path
        className="sort-arrow"
        d={isDescending(mode) ? 'M3 13.4h8.5M9.3 11.2l2.2 2.2-2.2 2.2' : 'M3 15.2h8.5M9.3 13l2.2 2.2-2.2 2.2'}
      />
    </svg>
  )
}

/** Same glyph in the panel rows, without the arrow: direction is in the words. */
function SortOptionIcon({ mode }: { mode: SortMode }): React.JSX.Element {
  return (
    <svg className="sort-option-icon" viewBox="0 0 16 16" aria-hidden="true">
      {isByName(mode) ? (
        <path d="M2.5 4h5M2.5 8h3.5M12 3.5v8M10 9.3l2 2.2 2-2.2" />
      ) : (
        <>
          <circle cx="8" cy="8" r="5.2" />
          <path d="M8 5.2V8l2.2 1.4" />
        </>
      )}
    </svg>
  )
}
