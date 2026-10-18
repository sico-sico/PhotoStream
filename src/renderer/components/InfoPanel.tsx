import type { MessageKey } from '@shared/i18n/messages'
import { buildExifSections, type RawExif } from '@shared/exif'
import type { Photo } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface InfoPanelProps {
  photo: Photo
  /** `null` while the read is in flight; `{}` when the file has no EXIF. */
  exif: RawExif | null
  onClose: () => void
}

/**
 * Collapsible EXIF detail panel for the viewer.
 *
 * Deliberately a side panel rather than an overlay: the photo stays visible
 * while its settings are read, which is the whole reason to look at both at once.
 *
 * Values are translated where they are labels, and left verbatim where they are
 * data — a lens called "FE 24-70mm F2.8 GM II" must not be translated.
 */
export function InfoPanel({ photo, exif, onClose }: InfoPanelProps): React.JSX.Element {
  const { t } = useI18n()

  // Loading, and "this file simply has no EXIF", are different states: one shows
  // a placeholder, the other should not pretend something is coming.
  const sections =
    exif === null
      ? null
      : buildExifSections(exif, {
          fileName: photo.name,
          width: photo.width,
          height: photo.height,
          dateSource: photo.dateSource
        })

  return (
    <aside className="info-panel" data-testid="info-panel" aria-label={t('viewer.info')}>
      <header className="info-head">
        <h2>{t('viewer.info')}</h2>
        <button type="button" className="button ghost" onClick={onClose} aria-label={t('viewer.hideInfo')}>
          ✕
        </button>
      </header>

      <div className="info-body">
        {sections === null ? (
          <p className="info-empty">{t('exif.loading')}</p>
        ) : (
          sections.map((section) => (
            <section key={section.key} className="info-section">
              <h3>{t(section.key as MessageKey)}</h3>
              <dl>
                {section.fields.map((field) => (
                  <div key={field.label} className="info-row">
                    <dt>{t(field.label as MessageKey)}</dt>
                    {/*
                      A value that is itself a message key (flash fired / not
                      fired) is translated; anything else is shown verbatim.
                    */}
                    <dd dir="auto">{field.value.startsWith('exif.') ? t(field.value as MessageKey) : field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}
