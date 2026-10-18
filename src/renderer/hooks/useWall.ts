import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Filters, LayoutMode, Photo, Settings, ThumbLevel } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { applyFilters } from '@shared/filters'
import { computeLayout } from '@shared/layout'
import { pickThumbLevel } from '@shared/thumbs'
import { fitTransform, type Transform } from '@shared/transform'
import { INITIAL_STATE, reducer } from '../state/wallReducer'

/**
 * Wires the renderer to the main process and derives everything the wall needs.
 *
 * All decisions worth testing live in `@shared/*`; this hook only sequences
 * them and keeps React state in sync.
 */
export interface UseWall {
  state: typeof INITIAL_STATE
  visiblePhotos: Photo[]
  layout: ReturnType<typeof computeLayout>
  thumbLevel: ThumbLevel
  thumbUrls: Record<string, string>
  transform: Transform
  /** Accepts a value or an updater, exactly like `useState`'s setter. */
  setTransform: React.Dispatch<React.SetStateAction<Transform>>
  progress: { done: number; total: number } | null
  busy: boolean
  chooseFolder: () => Promise<void>
  setFilters: (filters: Filters) => void
  resetFilters: () => void
  setLayout: (layout: LayoutMode) => void
  setLocale: (locale: string) => void
  select: (id: string | null) => void
  step: (delta: number) => void
  openPhoto: Photo | null
  fitToView: (viewport: { width: number; height: number }) => void
}

export function useWall(viewport: { width: number; height: number }): UseWall {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const requested = useRef(new Set<string>())
  // Set once the stored settings have been applied. Guards the persist effect
  // below so mount-time defaults never overwrite the user's file.
  const hydratedRef = useRef(false)
  const [restored, setRestored] = useState(false)
  // The reducer owns the locale so persistence has a single source of truth;
  // a ref mirrors it for callbacks that must not be re-created on every change.
  const localeRef = useRef('')

  const visiblePhotos = useMemo(() => applyFilters(state.photos, state.filters), [state.photos, state.filters])

  // The wall always spans the viewport width so rows break at the window edge.
  const layout = useMemo(
    () =>
      computeLayout(visiblePhotos, {
        mode: state.layout,
        containerWidth: Math.max(320, viewport.width)
      }),
    [visiblePhotos, state.layout, viewport.width]
  )

  const thumbLevel = useMemo(() => pickThumbLevel(300, transform.scale, window.devicePixelRatio || 1), [transform.scale])

  const openPhoto = useMemo(
    () => state.photos.find((photo) => photo.id === state.selectedId) ?? null,
    [state.photos, state.selectedId]
  )

  // Restore the previous session once, before the user does anything.
  useEffect(() => {
    if (hydratedRef.current) return
    void (async () => {
      let settings: Settings = { ...DEFAULT_SETTINGS, filters: { ...DEFAULT_SETTINGS.filters } }
      try {
        settings = await window.photoStream.loadSettings()
      } catch {
        // A corrupt or unreadable settings file must not prevent startup; the
        // defaults above are already a usable configuration.
      }
      localeRef.current = settings.locale ?? DEFAULT_SETTINGS.locale
      dispatch({ type: 'layout/set', layout: settings.layout ?? DEFAULT_SETTINGS.layout })
      dispatch({ type: 'filters/set', filters: settings.filters ?? DEFAULT_SETTINGS.filters })
      dispatch({ type: 'locale/set', locale: settings.locale ?? DEFAULT_SETTINGS.locale })
      if (settings.lastDir) await openDirectory(settings.lastDir)
    })()
      .catch(() => {
        // `openDirectory` already records its own failure in state; this catch
        // only stops a stray rejection from surfacing as an unhandled error.
      })
      .finally(() => {
        // Unblock persistence only now: the restored values are in state, so a
        // subsequent write cannot clobber the file with mount-time defaults.
        hydratedRef.current = true
        setRestored(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist layout/filters/lastDir/locale whenever they change, but never
  // before the stored values have been restored.
  //
  // This gate is a piece of state rather than a ref read inside the effect:
  // effects run in declaration order, so a ref-based guard would already read
  // `true` on the first pass and write defaults over the user's real file —
  // which silently reset layout, language and last folder on every launch.
  useEffect(() => {
    if (!restored) return
    localeRef.current = state.locale
    const settings: Settings = {
      lastDir: state.dir,
      layout: state.layout,
      filters: state.filters,
      locale: state.locale
    }
    void window.photoStream.saveSettings(settings)
  }, [restored, state.dir, state.layout, state.filters, state.locale])

  // Subscribe to watcher deltas and thumbnail progress.
  useEffect(() => {
    const offPhotos = window.photoStream.onPhotosChanged((payload) => {
      // The payload crosses an IPC boundary, so treat it as untrusted: a
      // malformed message must not take the whole wall down.
      const message = payload as { kind?: unknown; photos?: unknown; message?: unknown } | null
      if (!message || typeof message !== 'object') return
      if (message.kind === 'delta' && Array.isArray(message.photos)) {
        dispatch({ type: 'photos/delta', photos: message.photos as Photo[] })
      }
      if (message.kind === 'error' && typeof message.message === 'string') {
        dispatch({ type: 'scan/error', message: message.message })
      }
    })
    const offProgress = window.photoStream.onThumbProgress((payload) => {
      if (payload && typeof payload.done === 'number' && typeof payload.total === 'number') setProgress(payload)
    })
    return () => {
      offPhotos()
      offProgress()
    }
  }, [])

  const openDirectory = useCallback(async (dir: string) => {
    dispatch({ type: 'scan/start', dir })
    setThumbUrls({})
    requested.current.clear()
    try {
      const result = await window.photoStream.openDirectory(dir)
      dispatch({ type: 'scan/success', dir: result.dir, photos: result.photos })
    } catch (error) {
      dispatch({ type: 'scan/error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const chooseFolder = useCallback(async () => {
    const dir = await window.photoStream.pickDirectory(localeRef.current)
    if (dir) await openDirectory(dir)
  }, [openDirectory])

  // Fetch thumbnail URLs lazily, level by level, remembering what was asked for.
  useEffect(() => {
    let cancelled = false
    const pending = visiblePhotos.filter((photo) => !requested.current.has(`${photo.id}:${thumbLevel}`)).slice(0, 200)
    if (pending.length === 0) return

    void (async () => {
      const entries: Array<[string, string]> = []
      for (const photo of pending) {
        if (cancelled) return
        requested.current.add(`${photo.id}:${thumbLevel}`)
        try {
          entries.push([photo.id, await window.photoStream.thumbUrl(photo, thumbLevel)])
        } catch {
          // Leave the tile on its placeholder; a later pass can retry.
          requested.current.delete(`${photo.id}:${thumbLevel}`)
        }
      }
      if (!cancelled && entries.length > 0) {
        setThumbUrls((previous) => {
          const next = { ...previous }
          for (const [id, url] of entries) next[id] = url
          return next
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [visiblePhotos, thumbLevel])

  const fitToView = useCallback(
    (size: { width: number; height: number }) => {
      setTransform(fitTransform(layout.width, layout.height, size.width, size.height, { maxScale: 1 }))
    },
    [layout.width, layout.height]
  )

  const busy = state.status === 'scanning'

  return {
    state,
    visiblePhotos,
    layout,
    thumbLevel,
    thumbUrls,
    transform,
    setTransform,
    progress,
    busy,
    chooseFolder,
    setFilters: (filters) => dispatch({ type: 'filters/set', filters }),
    resetFilters: () => dispatch({ type: 'filters/reset' }),
    setLayout: (layout) => dispatch({ type: 'layout/set', layout }),
    setLocale: (locale) => dispatch({ type: 'locale/set', locale }),
    select: (id) => dispatch({ type: 'selection/set', id }),
    step: (delta) => dispatch({ type: 'selection/step', delta, order: visiblePhotos.map((photo) => photo.id) }),
    openPhoto,
    fitToView
  }
}
