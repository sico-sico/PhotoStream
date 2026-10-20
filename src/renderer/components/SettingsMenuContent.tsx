import { useEffect, useState } from 'react'
import { CACHE_BUDGET_PRESETS, RING_SIZE_RANGE, type CacheStats } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface SettingsMenuContentProps {
  /** Called after any change, so the menu can close itself. */
  onDone: () => void
  /** Opens the About dialog. The menu closes first, so it does not linger above it. */
  onAbout: () => void
  /** Whether photos in subfolders are included. */
  recursive: boolean
  /**
   * Applied immediately and re-scans the open folder.
   *
   * Unlike the language picker this does not close the menu: re-scanning is
   * visible behind the panel, so the user can turn it on, watch the count
   * change, and turn it back off without reopening the menu.
   */
  onRecursiveChange: (recursive: boolean) => void
  /** How many photos the random show rings around the centre one. */
  ringSize: number
  /** Applied immediately; the ring re-deals without waiting for a turnover. */
  onRingSizeChange: (ringSize: number) => void
  /** Thumbnail-cache limit in megabytes; `0` means unlimited. */
  cacheBudgetMb: number
  /**
   * Applied immediately and persisted.
   *
   * The menu stays open: shrinking the cache is a decision the user should be
   * able to watch take effect in the usage line right below it.
   */
  onCacheBudgetChange: (megabytes: number) => void
}

/**
 * Human-readable byte count.
 *
 * Units are deliberately not translated: "MB" and "GB" are read as symbols in
 * every locale this app ships, and a translated unit would make a number that is
 * supposed to be checkable against Explorer's own display harder to trust.
 */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`
  if (mb < 1024) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  const gb = mb / 1024
  // Whole gigabytes read as "2 GB" rather than "2.0 GB": the presets are round
  // numbers, and a stray decimal makes them look like measurements.
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}

/**
 * Contents of the gear menu.
 *
 * Everything here is a preference rather than a per-photo action, which is why
 * it does not deserve permanent toolbar space: the language picker alone was a
 * full-width select box on a bar that also had to hold the folder, layouts,
 * filters, sort order, photo count and window buttons.
 */
export function SettingsMenuContent({
  onDone,
  onAbout,
  recursive,
  onRecursiveChange,
  ringSize,
  onRingSizeChange,
  cacheBudgetMb,
  onCacheBudgetChange
}: SettingsMenuContentProps): React.JSX.Element {
  const { locale, available, setLocale, t } = useI18n()
  const [cache, setCache] = useState<CacheStats | null>(null)

  /*
   * The startup sweep runs ten seconds after launch, so the first time this menu
   * opens the total may still be unknown. Polling only until `ready` keeps the
   * line from lying ("0 B") without paying for an IPC round trip every second
   * for the life of the menu.
   */
  useEffect(() => {
    let live = true
    let timer: number | undefined
    const read = async (): Promise<void> => {
      try {
        const stats = await window.photoStream.cacheStats()
        if (!live) return
        setCache(stats)
        if (stats.ready && timer !== undefined) window.clearInterval(timer)
      } catch {
        // The menu simply shows nothing rather than a wrong number.
      }
    }
    timer = window.setInterval(() => void read(), 1000)
    void read()
    return () => {
      live = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="settings-menu">
      {/* A single language is not a choice; showing the row would be a dead control. */}
      {available.length > 1 ? (
        <label className="settings-field">
          <span>{t('toolbar.language')}</span>
          <select
            className="settings-language"
            aria-label={t('toolbar.language')}
            value={locale}
            onChange={(event) => {
              setLocale(event.target.value)
              onDone()
            }}
          >
            {available.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="settings-check">
        <input
          type="checkbox"
          checked={recursive}
          onChange={(event) => onRecursiveChange(event.target.checked)}
        />
        <span>{t('settings.recursive')}</span>
      </label>

      {/*
        Ring size.

        A slider rather than a number box: the useful range is narrow and the
        only way to know which value suits a screen is to see the ring change, so
        the control is meant to be dragged while the show is open behind it. The
        value is shown as a number because "70" is otherwise unreadable from a
        thumb's position.
      */}
      <label className="settings-field">
        <span>
          {t('settings.ringSize')}
          {/* Tabular digits, so dragging does not make the label jitter. */}
          <span className="settings-value">{ringSize}</span>
        </span>
        <input
          type="range"
          min={RING_SIZE_RANGE.min}
          max={RING_SIZE_RANGE.max}
          step={5}
          value={ringSize}
          aria-label={t('settings.ringSize')}
          onChange={(event) => onRingSizeChange(Number(event.target.value))}
        />
      </label>

      {/*
        Cache limit.

        "Unlimited" is the default because any number would be a guess about
        someone else's disk. The line under it reports what the cache is actually
        using, so the decision is made with the number in view instead of blind —
        and so the answer to "why is this folder 2 GB" is one click away.
      */}
      <label className="settings-field">
        <span>{t('settings.cacheBudget')}</span>
        <select
          aria-label={t('settings.cacheBudget')}
          value={cacheBudgetMb}
          onChange={(event) => onCacheBudgetChange(Number(event.target.value))}
        >
          {/* A hand-edited value outside the presets still has to be selectable,
              or the control would silently show the first option instead. */}
          {!(CACHE_BUDGET_PRESETS as readonly number[]).includes(cacheBudgetMb) ? (
            <option value={cacheBudgetMb}>{formatBytes(cacheBudgetMb * 1024 * 1024)}</option>
          ) : null}
          {CACHE_BUDGET_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset === 0 ? t('settings.cacheUnlimited') : formatBytes(preset * 1024 * 1024)}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-note">
        {cache !== null && cache.ready
          ? t('settings.cacheUsage', { size: formatBytes(cache.bytes) })
          : t('settings.cacheCalculating')}
      </p>
      {cacheBudgetMb === 0 ? <p className="settings-note">{t('settings.cacheUnlimitedHint')}</p> : null}

      <button
        type="button"
        className="button ghost settings-action"
        onClick={() => {
          // Close first: two stacked popups would fight over Escape and focus.
          onDone()
          onAbout()
        }}
      >
        {t('about.title')}
      </button>
    </div>
  )
}
