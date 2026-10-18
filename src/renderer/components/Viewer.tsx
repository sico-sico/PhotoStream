import { useEffect, useState } from 'react'
import type { Photo } from '@shared/types'
import { formatIsoDate } from '@shared/i18n'
import { useI18n } from '../i18n/context'

export interface ViewerProps {
  photo: Photo
  /** Cached thumbnail URL, shown immediately while the original decodes. */
  previewUrl: string | undefined
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onReveal: () => void
}

/**
 * Single-photo viewer.
 *
 * A 51 MB / 7952x5304 JPEG takes ~0.55 s to decode, so the cached thumbnail is
 * shown first and the original swapped in when it is ready. That removes the
 * white flash without any explicit loading spinner.
 */
export function Viewer({ photo, previewUrl, onClose, onPrev, onNext, onReveal }: ViewerProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const [fullLoaded, setFullLoaded] = useState(false)

  // Reset the swap state whenever the selected photo changes.
  useEffect(() => {
    setFullLoaded(false)
  }, [photo.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onPrev()
      else if (event.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev])

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={photo.name} data-testid="viewer">
      <div className="viewer-stage" onClick={onClose}>
        {previewUrl ? (
          <img className={`viewer-image preview ${fullLoaded ? 'hidden' : ''}`} src={previewUrl} alt="" aria-hidden="true" />
        ) : null}
        <img
          className={`viewer-image ${fullLoaded ? 'ready' : ''}`}
          src={`pic://photo/${encodeURIComponent(photo.name)}`}
          alt={photo.name}
          onLoad={() => setFullLoaded(true)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>

      <div className="viewer-bar" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="button ghost" onClick={onPrev} aria-label={t('viewer.prev')}>
          ←
        </button>
        <div className="viewer-meta">
          <strong dir="auto">{photo.name}</strong>
          <span>
            {photo.takenAt ? formatIsoDate(locale, photo.takenAt) : t('viewer.noDate')}
            {photo.width > 0 ? ` · ${t('viewer.size', { width: photo.width, height: photo.height })}` : ''}
          </span>
        </div>
        <button type="button" className="button ghost" onClick={onReveal}>
          {t('viewer.reveal')}
        </button>
        <button type="button" className="button ghost" onClick={onNext} aria-label={t('viewer.next')}>
          →
        </button>
        <button type="button" className="button" onClick={onClose} aria-label={t('viewer.close')}>
          ✕
        </button>
      </div>
    </div>
  )
}
