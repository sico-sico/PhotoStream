import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface AboutDialogProps {
  onClose: () => void
}

/**
 * Where the project lives.
 *
 * Shown verbatim as `owner/repo` next to the label rather than as a bare
 * "GitHub" link: the full URL is the useful thing to read out or copy, and the
 * label itself says nothing a user could not guess from the link text.
 */
const REPOSITORY_URL = 'https://github.com/sico-sico/PhotoStream'
const REPOSITORY_LABEL = 'sico-sico/PhotoStream'

/**
 * About dialog: version, runtime and the shortcuts worth learning.
 *
 * The shortcut list lives here rather than in a separate help screen because
 * the app is small and the list is short; one dialog that answers "what is this
 * and how do I drive it" is more useful than two.
 *
 * Accessibility follows the viewer's pattern: `role="dialog"`, `aria-modal`,
 * focus moved inside on open and returned to the opener on close, Escape and a
 * backdrop click both dismiss.
 */
export function AboutDialog({ onClose }: AboutDialogProps): React.JSX.Element {
  const { t } = useI18n()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.photoStream
      .appInfo()
      .then((value) => {
        if (!cancelled) setInfo(value)
      })
      .catch(() => {
        // The dialog is still readable without the version block; a missing
        // runtime string must not block opening it.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Focus lands on Close so the dialog is immediately dismissable from the
    // keyboard, and so screen readers announce its contents rather than
    // continuing from the toolbar behind it.
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Swallow it: the wall behind listens for Escape too.
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const shortcuts: Array<{ keys: string; label: string }> = [
    { keys: '↑ ↓ ← →', label: t('about.shortcutPan') },
    { keys: 'Shift + ↑ ↓ ← →', label: t('about.shortcutPanLarge') },
    { keys: 'Alt + ↑ ↓ ← →', label: t('about.shortcutFocus') },
    { keys: 'Enter / Space', label: t('about.shortcutViewer') },
    { keys: 'I', label: t('about.shortcutInfo') },
    { keys: 'Esc', label: t('about.shortcutClose') }
  ]

  return (
    <div
      className="about-backdrop"
      // Clicking the dimmed area dismisses, but a click that started inside the
      // panel (e.g. selecting the version text) must not.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-heading">
        <header className="about-header">
          <h2 id="about-heading">{t('about.title')}</h2>
          <p className="about-version">{t('about.version', { version: info?.version ?? '—' })}</p>
        </header>

        <p className="about-description">{t('about.description')}</p>

        {/**
         * The repository link.
         *
         * `target="_blank"` is deliberate rather than incidental: the main
         * process denies in-window navigation (`will-navigate` only allows the
         * app's own files) and routes `window.open` through `shell.openExternal`.
         * A plain anchor would therefore do nothing at all; `_blank` is what
         * hands the URL to the real browser.
         */}
        <p className="about-source">
          <span>{t('about.source')}</span>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener" dir="ltr">
            {REPOSITORY_LABEL}
          </a>
        </p>

        <section className="about-section">
          <h3>{t('about.shortcuts')}</h3>
          <dl className="about-shortcuts">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.keys} className="about-shortcut">
                <dt>
                  <kbd>{shortcut.keys}</kbd>
                </dt>
                <dd>{shortcut.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        {info ? (
          <section className="about-section">
            <h3>{t('about.runtime')}</h3>
            <dl className="about-facts">
              <div>
                <dt>{t('about.dataLocation')}</dt>
                {/* `dir="auto"` keeps a Windows path readable under an RTL locale. */}
                <dd dir="auto" title={info.dataDir}>
                  {info.dataDir}
                </dd>
              </div>
              <div>
                <dt>Electron</dt>
                <dd>{info.electron}</dd>
              </div>
              <div>
                <dt>Chromium</dt>
                <dd>{info.chromium}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        <footer className="about-footer">
          <button type="button" ref={closeRef} className="button primary" onClick={onClose}>
            {t('about.close')}
          </button>
        </footer>
      </div>
    </div>
  )
}
