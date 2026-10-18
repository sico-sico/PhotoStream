import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Filters, LayoutMode, Photo, Settings, SortMode, ThumbLevel } from '@shared/types'
import { DEFAULT_SETTINGS, DEFAULT_SORT } from '@shared/types'
import { applyFilters } from '@shared/filters'
import { computeLayout } from '@shared/layout'
import { pickThumbLevel, REFERENCE_TILE } from '@shared/thumbs'
import { clampWallTransform, fitWallTransform, type Transform } from '@shared/transform'
import { reanchorTransform } from '@shared/reanchor'
import { prefetchIdsForScroll } from '@shared/cull'
import { INITIAL_STATE, reducer } from '../state/wallReducer'

/**
 * How many destination tiles to prefetch for a scrollbar jump.
 *
 * Deliberately about one screenful, not the whole padded band. The main process
 * encodes four at a time, so a bigger batch does not arrive sooner — it just
 * pushes the tiles that are already visible further back in the queue. Measured
 * on 3226 photos: a 400-tile prefetch left 14 of 81 visible tiles empty 15 s
 * after the jump.
 */
const PREFETCH_BATCH = 80

/**
 * Delay before a prefetch starts.
 *
 * Long enough for the tiles currently on screen to be requested and encoded
 * first, short enough to still be ahead of the ~220 ms scroll animation.
 */
const PREFETCH_DELAY_MS = 120

/**
 * How long after the last scroll target the wall returns to normal priority.
 *
 * Slightly longer than the 220 ms scroll animation, so the landing's own tiles
 * are requested while still in "scrolling" mode and the switch back does not
 * race the arrival.
 */
const SCROLL_SETTLE_MS = 300

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
  /** Open a folder (or the folder of a photo) dropped on the window. */
  openDropped: (path: string) => Promise<void>
  /** Whether subfolders are included, and the setter that re-scans. */
  setRecursive: (recursive: boolean) => void
  /**
   * Start loading thumbnails around a scroll destination.
   *
   * Called as soon as the scrollbar knows where it is going, so the wall is not
   * blank when the animation arrives there.
   */
  prefetchForScroll: (targetY: number) => void
  /** Open a folder straight from the recent-folders list. */
  openHistoryEntry: (dir: string) => Promise<void>
  /** Remember whether the viewer's EXIF panel is shown. */
  setViewerInfo: (open: boolean) => void
  /** Forget one recent folder. */
  removeHistoryEntry: (dir: string) => void
  /** Forget every recent folder. */
  clearHistory: () => void
  setFilters: (filters: Filters) => void
  resetFilters: () => void
  setLayout: (layout: LayoutMode) => void
  setSort: (sort: SortMode) => void
  setLocale: (locale: string) => void
  select: (id: string | null) => void
  /** Focus a photo without opening the viewer (arrow-key navigation). */
  focus: (id: string | null) => void
  /** Close the viewer but keep the focused photo. */
  closeViewer: () => void
  /** Open the focused photo in the viewer (keyboard equivalent of a click). */
  openSelected: () => void
  step: (delta: number) => void
  openPhoto: Photo | null
  fitToView: (viewport: { width: number; height: number }) => void
}

export function useWall(viewport: { width: number; height: number }): UseWall {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const requested = useRef(new Set<string>())
  /**
   * Renditions received per photo, by level.
   *
   * Kept as a map of *all* levels rather than a single "best so far" value,
   * because the right rendition depends on the current zoom and that changes in
   * both directions. The previous version recorded only the highest level ever
   * received and refused to downgrade, so after one zoom-in a tile kept
   * displaying a multi-megapixel original even when zoomed back out — measured
   * at 1239 MB in the renderer and 790 MB of GPU memory after a single
   * in-and-out gesture, versus 142 MB at rest.
   */
  const renditionUrls = useRef(new Map<string, Partial<Record<ThumbLevel, string>>>())
  // Set once the stored settings have been applied. Guards the persist effect
  // below so mount-time defaults never overwrite the user's file.
  const hydratedRef = useRef(false)
  const [restored, setRestored] = useState(false)
  // The reducer owns the locale so persistence has a single source of truth;
  // a ref mirrors it for callbacks that must not be re-created on every change.
  const localeRef = useRef('')
  /**
   * Latest `recursive` preference, read by the open callbacks.
   *
   * A ref because `openDirectory` must not be re-created when the preference
   * changes: it is a dependency of the folder picker, the history menu and the
   * drop handler, and a new identity there would re-subscribe window listeners
   * on every toggle.
   */
  const recursiveRef = useRef(false)
  /**
   * Whether the user has opened a folder themselves.
   *
   * `loadSettings` is async, so a drop that lands in the first moments after
   * launch is processed *before* the restore gets to reopen `lastDir`. Without
   * this flag the restore would then be the newest open and silently replace the
   * folder the user had just dropped — the "quick drag sometimes does nothing"
   * report.
   */
  const userOpenedRef = useRef(false)
  /** Latest reducer state, for callbacks that must not be re-created per change. */
  const stateRef = useRef(state)
  stateRef.current = state
  /** Latest viewport, read by effects that must not re-run on every resize. */
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  const visiblePhotos = useMemo(() => applyFilters(state.photos, state.filters), [state.photos, state.filters])

  /**
   * Width the wall is laid out for, in world units.
   *
   * Normally the viewport width, so rows break at the window edge. When zoomed
   * out, the same window covers *more* world width than the window itself: the
   * wall would then be narrower than the visible area and empty bands would
   * appear at both sides. Widening the layout by `1/scale` makes the columns
   * fill the window at any zoom, which is what a photo wall should do.
   *
   * Zooming in is deliberately excluded: it would reflow the whole library while
   * the user is inspecting one photo, and at that point there is nothing to fill.
   */
  const layoutWidth = useMemo(() => {
    const base = Math.max(320, viewport.width)
    if (!(transform.scale < 1)) return base
    return Math.round(base / transform.scale)
  }, [transform.scale, viewport.width])

  // The wall spans the width it is laid out for, so rows break at the window edge.
  const layout = useMemo(
    () =>
      computeLayout(visiblePhotos, {
        mode: state.layout,
        containerWidth: layoutWidth
      }),
    [visiblePhotos, state.layout, layoutWidth]
  )

  /**
   * Re-anchor and re-clamp when a re-layout moves every tile.
   *
   * Zooming out changes `layoutWidth`, so the whole wall is re-flowed. Two
   * things must follow:
   * 1. the transform is re-anchored, or the view appears to jump (reported as
   *    "zooming sends me back to the first photo");
   * 2. it is clamped again against the *new* dimensions.
   *
   * Step 2 is why this cannot live only in `clampedSetTransform`: that wrapper
   * runs while the old layout is still current, so a zoom-out clamps against a
   * wall that is about to become wider and pins x to 0. The new layout then
   * leaves a band of empty space on the right, which is exactly the gap users
   * saw after zooming.
   */
  const previousLayout = useRef(layout)
  useEffect(() => {
    const before = previousLayout.current
    previousLayout.current = layout
    if (before === layout) return
    if (before.items.length === 0 || layout.items.length === 0) return
    // Only a geometry change matters; the same items at the same places have
    // nothing to re-anchor.
    if (before.width === layout.width && before.height === layout.height) return

    const { width, height } = viewportRef.current
    setTransform((current) =>
      clampWallTransform(reanchorTransform(current, before, layout, viewportRef.current), layout.width, layout.height, width, height)
    )
  }, [layout])

  const thumbLevel = useMemo(
    () => pickThumbLevel(REFERENCE_TILE, transform.scale, window.devicePixelRatio || 1),
    [transform.scale]
  )

  /**
   * Ids of tiles currently inside the viewport, plus a small margin.
   *
   * Thumbnails are only requested for these. Asking for every photo in the
   * folder was the reason a large library took minutes to become usable: the
   * main process encoded thousands of renditions the user never scrolled to.
   * The margin pre-fetches one screen in each direction so ordinary panning
   * does not show empty tiles.
   */
  const visibleIds = useMemo(() => {
    const margin = Math.max(viewport.width, viewport.height)
    const left = (-transform.x - margin) / transform.scale
    const top = (-transform.y - margin) / transform.scale
    const right = (viewport.width - transform.x + margin) / transform.scale
    const bottom = (viewport.height - transform.y + margin) / transform.scale

    const ids = new Set<string>()
    for (const item of layout.items) {
      if (item.x + item.w < left || item.x > right) continue
      if (item.y + item.h < top || item.y > bottom) continue
      ids.add(item.id)
    }
    return ids
  }, [layout.items, transform.x, transform.y, transform.scale, viewport.width, viewport.height])

  /**
   * World row the scrollbar is heading for, or `null` when idle.
   *
   * Kept in state rather than a ref so the prefetch effect below re-runs when a
   * new destination is announced, including two jumps to the same place (which a
   * ref comparison would swallow).
   */
  const [scrollTargetY, setScrollTargetY] = useState<number | null>(null)

  const openPhoto = useMemo(
    () => (state.viewerOpen ? state.photos.find((photo) => photo.id === state.selectedId) ?? null : null),
    [state.photos, state.selectedId, state.viewerOpen]
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
      dispatch({ type: 'sort/set', sort: settings.sort ?? DEFAULT_SORT })
      dispatch({ type: 'filters/set', filters: settings.filters ?? DEFAULT_SETTINGS.filters })
      dispatch({ type: 'locale/set', locale: settings.locale ?? DEFAULT_SETTINGS.locale })
      // Restore the list verbatim; `sanitizeSettings` already validated it in the
      // main process, and re-checking here would be a second source of truth.
      dispatch({ type: 'history/set', history: settings.history ?? [] })
      recursiveRef.current = settings.recursive === true
      dispatch({ type: 'recursive/set', recursive: recursiveRef.current })
      // Restore how the user last wanted the EXIF panel. Absent in files written
      // before this preference existed, which `== true` treats as off.
      dispatch({ type: 'viewer/info', open: settings.viewerInfo === true })
      // Only reopen the remembered folder if the user has not opened one
      // themselves already. `loadSettings` is async, so a folder dragged in
      // right after launch arrives before this point — and reopening `lastDir`
      // afterwards is a *later* open, which would win and silently replace the
      // folder the user had just dropped. That is the "quick drag does nothing"
      // report.
      if (settings.lastDir && !userOpenedRef.current) {
        await openDirectory(settings.lastDir, { user: false })
      }
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
      sort: state.sort,
      filters: state.filters,
      locale: state.locale,
      history: state.history,
      recursive: state.recursive,
      viewerInfo: state.viewerInfo
    }
    void window.photoStream.saveSettings(settings)
  }, [
    restored,
    state.dir,
    state.layout,
    state.sort,
    state.filters,
    state.locale,
    state.history,
    state.recursive,
    state.viewerInfo
  ])

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

  /**
   * Which scan the wall is currently waiting for.
   *
   * Every open bumps this. When a scan resolves, it only applies if no later
   * open has started in the meantime — otherwise dropping several folders in a
   * row leaves the wall showing whichever scan the disk finished last, which is
   * not the folder the user dropped last.
   */
  const scanGeneration = useRef(0)

  /** Claim the next scan slot. Call before the IPC, pair with `finishScan`. */
  const beginScan = useCallback((): number => {
    scanGeneration.current += 1
    return scanGeneration.current
  }, [])

  /** Whether `generation` is still the newest scan. */
  const finishScan = useCallback((generation: number): boolean => generation === scanGeneration.current, [])

  const openDirectory = useCallback(
    async (dir: string, options: { user?: boolean } = {}) => {
      // Defaults to a user action: every caller except the startup restore is
      // one. The restore passes `user: false` so a folder dropped during launch
      // is not then replaced by the remembered one.
      if (options.user !== false) userOpenedRef.current = true
      dispatch({ type: 'scan/start', dir })
      requested.current.clear()
      renditionUrls.current.clear()
      setRenditionTick((value) => value + 1)
      const generation = beginScan()
      try {
        const result = await window.photoStream.openDirectory(dir, recursiveRef.current)
        if (!finishScan(generation)) return
        dispatch({ type: 'scan/success', dir: result.dir, photos: result.photos })
      } catch (error) {
        if (!finishScan(generation)) return
        dispatch({ type: 'scan/error', message: error instanceof Error ? error.message : String(error) })
      }
    },
    [beginScan, finishScan]
  )

  const chooseFolder = useCallback(async () => {
    const dir = await window.photoStream.pickDirectory(localeRef.current)
    if (dir) await openDirectory(dir)
  }, [openDirectory])

  /** Open a folder straight from the history list. */
  const openHistoryEntry = useCallback((dir: string) => openDirectory(dir), [openDirectory])

  /**
   * Remember whether the EXIF panel is shown.
   *
   * Persisted with the other preferences: the choice describes how the user
   * wants to browse, so it has to survive stepping to the next photo, closing
   * the viewer and restarting the app.
   */
  const setViewerInfo = useCallback((open: boolean) => dispatch({ type: 'viewer/info', open }), [])

  /** Forget one folder. Does not touch the library that is currently open. */
  const removeHistoryEntry = useCallback((dir: string) => dispatch({ type: 'history/remove', dir }), [])

  const clearHistory = useCallback(() => dispatch({ type: 'history/clear' }), [])

  /**
   * Toggle subfolder scanning.
   *
   * Re-opens the current folder immediately: the preference only changes what
   * the main process scans, so without a re-scan the setting would appear to do
   * nothing until the user happened to open something else. The ref is updated
   * first so `openDirectory` sees the new value.
   */
  const setRecursive = useCallback(
    (recursive: boolean) => {
      recursiveRef.current = recursive
      dispatch({ type: 'recursive/set', recursive })
      const current = stateRef.current.dir
      if (current) void openDirectory(current)
    },
    [openDirectory]
  )

  /**
   * Open a path the user handed to the app.
   *
   * Used by both entry points — a drop on the window and Explorer's "Open with"
   * — so they cannot drift apart. A folder opens at the top; a single photo
   * opens its folder *and* focuses that photo, which is what "open this picture"
   * means to the user.
   *
   * The target is resolved in the main process (a folder opens itself, a photo
   * opens its folder) so the renderer never has to guess what a path is. An
   * empty path means the drop carried no real file - a paste or an internal
   * drag - and is ignored rather than reported as an error.
   */
  const openDropped = useCallback(
    async (path: string, options: { focus?: boolean } = {}) => {
      if (!path) return
      // A drop is always the user asking for this folder.
      userOpenedRef.current = true
      dispatch({ type: 'scan/start', dir: path })
      requested.current.clear()
      renditionUrls.current.clear()
      setRenditionTick((value) => value + 1)
      const generation = beginScan()
      try {
        const result = await window.photoStream.openDropped(path, recursiveRef.current)
        // A later drop has taken over: this result is for a folder the user
        // moved on from, so it must not replace the wall they are now looking
        // at. Dropping several folders in a row is exactly this case — the
        // scans finish in whatever order the disk decides.
        if (!finishScan(generation)) return
        dispatch({ type: 'scan/success', dir: result.dir, photos: result.photos })

        // Focus the photo the user pointed at. `path` is absolute and photos are
        // keyed by a lower-cased path, so the id is derived the same way the
        // scanner does it rather than compared as strings.
        if (result.photo) {
          const focusId = result.photo.toLowerCase()
          const target = result.photos.find((photo) => photo.id === focusId)
          if (target) {
            dispatch({ type: 'selection/focus', id: target.id })
            // Open with details: the user pointed at a specific file from
            // outside the app, so its metadata is part of what they asked about.
            // A drop on the wall means the same thing. `options.focus === false`
            // is used by the caller that wants the wall centred without the
            // viewer.
            if (options.focus !== false) dispatch({ type: 'viewer/openWithInfo' })
          }
        }
      } catch (error) {
        // An abandoned scan failing is not the user's problem: reporting it
        // would replace a good wall with an error about a folder they have
        // already moved on from.
        if (!finishScan(generation)) return
        dispatch({ type: 'scan/error', message: error instanceof Error ? error.message : String(error) })
      }
    },
    [beginScan, finishScan]
  )

  const openDroppedRef = useRef(openDropped)
  openDroppedRef.current = openDropped

  // A photo handed over from Explorer ("Open with → PhotoStream"). The main
  // process forwards it here instead of opening a second window, so a
  // right-click launch behaves exactly like dropping the file.
  useEffect(() => {
    return window.photoStream.onOpenExternal((path) => {
      void openDroppedRef.current(path)
    })
  }, [])

  // Record every rendition as it arrives, so the wall can show the one matching
  // the current zoom instead of whatever was sharpest a moment ago.
  //
  // `tick` exists because `renditionUrls` is a ref: mutating it does not
  // re-render, and the derived map below has to be recomputed when a new
  // rendition lands.
  const [renditionTick, setRenditionTick] = useState(0)
  useEffect(() => {
    return window.photoStream.onThumbReady(([id, url, level]) => {
      const byLevel = renditionUrls.current.get(id) ?? {}
      if (byLevel[level] === url) return
      byLevel[level] = url
      renditionUrls.current.set(id, byLevel)
      setRenditionTick((value) => value + 1)
    })
  }, [])

  /**
   * URLs at the level the current zoom calls for.
   *
   * This is what makes zooming back out cheap again: the tile returns to its
   * 512px WebP and the browser releases the decoded original. Previously the
   * highest level ever received was kept, so one zoom-in pinned every visited
   * tile to a multi-megapixel image — 1239 MB in the renderer after a single
   * in-and-out gesture.
   *
   * A level that has not arrived yet falls back to one that has, preferring
   * sharper over blank: a briefly over-sharp tile is far less jarring than an
   * empty box.
   */
  const thumbUrls = useMemo(() => {
    const urls: Record<string, string> = {}
    for (const photo of visiblePhotos) {
      const byLevel = renditionUrls.current.get(photo.id)
      if (!byLevel) continue
      const url = byLevel[thumbLevel] ?? byLevel.wall ?? byLevel.zoom ?? byLevel.full
      if (url) urls[photo.id] = url
    }
    return urls
  }, [visiblePhotos, thumbLevel, renditionTick])

  /**
   * Ask for whatever is on screen that has not been requested yet.
   *
   * Normally `interactive`: these are the tiles the user is looking at, and the
   * main process must serve them before any speculative work.
   *
   * While a scroll target is pending it asks for nothing at all. A drag emits a
   * transform per pointer event and each one brings a fresh band into view, so
   * this effect fired tens of times a second with ~70 photos each — measured at
   * 30+ batches of 60–80 tiles during a single sweep. The main process encodes
   * four images at a time, so those bands did not arrive sooner; they filled the
   * queue, and the destination the drag was heading for sat behind all of them.
   * A measured drag left all 84 mounted tiles blank for the full 5 s window,
   * even with the requests demoted to `background`.
   *
   * So during a scroll the destination is the only thing requested (by the
   * prefetch below), and the bands the thumb swept past are simply skipped: they
   * are not what the user is about to look at. Once the scroll settles,
   * `scrollTargetY` clears and this effect loads the final band at interactive
   * priority, which is the view that actually matters.
   */
  useEffect(() => {
    if (scrollTargetY !== null) return

    const pending = visiblePhotos
      .filter((photo) => visibleIds.has(photo.id) && !requested.current.has(`${photo.id}:${thumbLevel}`))
      .slice(0, 400)
    if (pending.length === 0) return

    for (const photo of pending) requested.current.add(`${photo.id}:${thumbLevel}`)
    void window.photoStream.requestThumbs(pending, thumbLevel, 'interactive').catch(() => {
      // Allow a later pass to retry if the IPC itself failed.
      for (const photo of pending) requested.current.delete(`${photo.id}:${thumbLevel}`)
    })
  }, [visiblePhotos, visibleIds, thumbLevel, scrollTargetY])

  /**
   * Prefetch the destination of a scrollbar jump.
   *
   * Runs on the target rather than the current view, so the batch is already in
   * flight while the wall is still animating towards it.
   *
   * Measurements on the 3226-photo library drove two constraints that are not
   * obvious from the idea alone:
   *
   * 1. **A small batch.** The main process encodes four images at a time, so a
   *    request for hundreds of tiles does not arrive sooner — it *occupies* the
   *    queue. An earlier version asked for the whole padded band and made the
   *    landing worse: 15 s after a jump, 14 of 81 visible tiles still had no
   *    image, because the visible ones were behind the prefetch in the queue.
   *    One screenful ahead is enough to cover the animation.
   * 2. **Delayed start.** Firing immediately competes with the tiles that are
   *    already on screen and unloaded, which are what the user is looking at
   *    right now. A short delay lets the current viewport win.
   *
   * Keyed on `scrollTargetY` rather than done inside the callback: a drag emits
   * many pointer events, and asking once per event would flood the IPC channel.
   * The state change coalesces them into one request per distinct destination.
   */
  useEffect(() => {
    if (scrollTargetY === null) return

    const timer = window.setTimeout(() => {
      const { width, height } = viewportRef.current
      const ids = prefetchIdsForScroll(layout, scrollTargetY, width, height, transform.scale)
      if (ids.length === 0) return

      const byId = new Map(visiblePhotos.map((photo) => [photo.id, photo]))
      const pending = ids
        .map((id) => byId.get(id))
        .filter((photo): photo is Photo => photo !== undefined)
        .filter((photo) => !requested.current.has(`${photo.id}:${thumbLevel}`))
        .slice(0, PREFETCH_BATCH)
      if (pending.length === 0) return

      for (const photo of pending) requested.current.add(`${photo.id}:${thumbLevel}`)
      // `background`: the main process must never delay an on-screen tile for
      // one of these.
      void window.photoStream.requestThumbs(pending, thumbLevel, 'background').catch(() => {
        for (const photo of pending) requested.current.delete(`${photo.id}:${thumbLevel}`)
      })
    }, PREFETCH_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [scrollTargetY, layout.items, thumbLevel, visiblePhotos, transform.scale])

  /**
   * Leave "scrolling" mode once the destination has stopped moving.
   *
   * `scrollTargetY` doubles as the signal that a scroll is in flight: while it is
   * set, the viewport effect demotes its requests to `background` so the prefetch
   * can win the queue. It has to be cleared afterwards, or every later request
   * would stay demoted and ordinary panning would load at speculative priority.
   *
   * A settle delay rather than clearing inside the prefetch: a drag re-targets on
   * every pointer event, and clearing there would flap in and out of the mode
   * dozens of times a second.
   */
  useEffect(() => {
    if (scrollTargetY === null) return
    const timer = window.setTimeout(() => setScrollTargetY(null), SCROLL_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [scrollTargetY])

  const prefetchForScroll = useCallback((targetY: number) => setScrollTargetY(targetY), [])

  const fitToView = useCallback(
    (size: { width: number; height: number }) => {
      setTransform(fitWallTransform(layout.width, layout.height, size.width, size.height, { maxScale: 1 }))
    },
    [layout.width, layout.height]
  )

  const busy = state.status === 'scanning'

  /**
   * Every transform write goes through the bounds.
   *
   * Dragging, the wheel, the keyboard, fitting and the zoom re-anchor all end up
   * here, so clamping at this one point is what guarantees no caller can leave
   * the wall showing empty space. Wrapping `setTransform` rather than each call
   * site also means a future caller cannot forget it.
   */
  const clampedSetTransform = useCallback<React.Dispatch<React.SetStateAction<Transform>>>(
    (value) => {
      setTransform((previous) => {
        const next = typeof value === 'function' ? (value as (p: Transform) => Transform)(previous) : value
        return clampWallTransform(next, layout.width, layout.height, viewportRef.current.width, viewportRef.current.height)
      })
    },
    [layout.height, layout.width]
  )

  return {
    state,
    visiblePhotos,
    layout,
    thumbLevel,
    thumbUrls,
    transform,
    setTransform: clampedSetTransform,
    progress,
    busy,
    chooseFolder,
    openDropped,
    prefetchForScroll,
    setRecursive,
    openHistoryEntry,
    removeHistoryEntry,
    clearHistory,
    setViewerInfo,
    setFilters: (filters) => dispatch({ type: 'filters/set', filters }),
    resetFilters: () => dispatch({ type: 'filters/reset' }),
    setLayout: (layout) => dispatch({ type: 'layout/set', layout }),
    setSort: (sort) => dispatch({ type: 'sort/set', sort }),
    setLocale: (locale) => dispatch({ type: 'locale/set', locale }),
    select: (id) => dispatch({ type: 'selection/set', id }),
    focus: (id) => dispatch({ type: 'selection/focus', id }),
    closeViewer: () => dispatch({ type: 'viewer/close' }),
    openSelected: () => dispatch({ type: 'viewer/open' }),
    step: (delta) => dispatch({ type: 'selection/step', delta, order: visiblePhotos.map((photo) => photo.id) }),
    openPhoto,
    fitToView
  }
}
