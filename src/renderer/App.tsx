import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilterPanel } from './components/FilterPanel'
import { Toolbar } from './components/Toolbar'
import { Viewer } from './components/Viewer'
import { Wall } from './components/Wall'
import type { WallHandle } from './components/Wall'
import { usePanZoom } from './hooks/usePanZoom'
import { useWall } from './hooks/useWall'
import { I18nProvider } from './i18n/I18nProvider'
import { useI18n } from './i18n/context'
import { fitWallTransform } from '@shared/transform'
import type { Transform } from '@shared/transform'
import { centerOn, isComfortablyVisible, isPanKey, neighbourInDirection, panByKey } from '@shared/keyboard'
import type { AppInfo } from '@shared/types'

/** Measure an element's box, re-measuring on resize. */
function useViewportSize(): { width: number; height: number; ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setSize({ width: Math.round(box.width), height: Math.round(box.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ...size, ref }
}

export default function App(): React.JSX.Element {
  const viewport = useViewportSize()
  const wall = useWall({ width: viewport.width, height: viewport.height })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [systemLocales, setSystemLocales] = useState<string[]>([])

  // The OS locale list decides the initial language when the user has not
  // picked one. Fetching it is cheap and independent of the photo scan.
  useEffect(() => {
    void (async () => {
      try {
        const info: AppInfo = await window.photoStream.appInfo()
        setSystemLocales(info.systemLocales ?? [])
      } catch {
        // Falls back to the default locale; a missing list is not fatal.
      }
    })()
  }, [])

  return (
    <I18nProvider
      preference={wall.state.locale}
      systemLocales={systemLocales}
      onLocaleChange={wall.setLocale}
    >
      <AppView viewport={viewport} wall={wall} filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen} />
    </I18nProvider>
  )
}

function AppView({
  viewport,
  wall,
  filtersOpen,
  setFiltersOpen
}: {
  viewport: ReturnType<typeof useViewportSize>
  wall: ReturnType<typeof useWall>
  filtersOpen: boolean
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>
}): React.JSX.Element {
  const { t } = useI18n()
  const fittedFor = useRef('')
  const wallRef = useRef<WallHandle | null>(null)
  // Read inside the pan callback, which must not be re-created per transform.
  const transformRef = useRef(wall.transform)
  transformRef.current = wall.transform

  /**
   * Whether the next transform change should be animated.
   *
   * Only programmatic moves animate. A drag or a wheel zoom that eased would
   * lag the pointer, which feels broken rather than smooth, so those paths turn
   * it off before touching the transform.
   */
  const [animate, setAnimate] = useState(false)
  const animateTimer = useRef<number | null>(null)
  const moveWithAnimation = useCallback((next: Transform) => {
    setAnimate(true)
    wall.setTransform(next)
    // Reset after the transition would have finished, so a later drag starts
    // from a still wall.
    if (animateTimer.current !== null) window.clearTimeout(animateTimer.current)
    animateTimer.current = window.setTimeout(() => setAnimate(false), 260)
  }, [wall])

  useEffect(() => () => {
    if (animateTimer.current !== null) window.clearTimeout(animateTimer.current)
  }, [])

  const handlers = usePanZoom(wall.setTransform, {
    onItemClick: (id) => wall.select(id),
    onBackgroundClick: () => setFiltersOpen(false),
    // Per-frame pan goes straight to the DOM; state is committed on release.
    onLiveTransform: (next) => {
      // Following the cursor exactly: no easing allowed mid-drag.
      setAnimate(false)
      wallRef.current?.applyTransform(next)
    },
    getTransform: () => transformRef.current
  })
  /**
   * Frame the wall when the folder or the layout *mode* changes.
   *
   * The world dimensions are deliberately not part of this key. Zooming out
   * re-lays the wall out at a wider width so the columns fill the window, and an
   * earlier version keyed the fit on those dimensions — so every zoom step
   * looked like "a new wall" and snapped the view back to the top-left, which
   * the user saw as being thrown back to the first photo.
   */
  const fitKey = `${wall.state.dir}|${wall.state.layout}`
  useEffect(() => {
    if (wall.layout.items.length === 0) return
    if (fittedFor.current === fitKey) return
    fittedFor.current = fitKey
    // Fit by width: a tall wall is opened at the top, at full window width.
    wall.setTransform(
      fitWallTransform(wall.layout.width, wall.layout.height, viewport.width, viewport.height, { maxScale: 1 })
    )
  }, [fitKey, viewport.height, viewport.width, wall])

  const visibleUrl = useMemo(
    () => (wall.openPhoto ? wall.thumbUrls[wall.openPhoto.id] : undefined),
    [wall.openPhoto, wall.thumbUrls]
  )

  /**
   * Arrow keys move the canvas; Alt+arrows move the focused photo.
   *
   * Panning must stay on the bare arrows. An earlier version switched them to
   * "walk the selection" whenever a photo was focused, which meant that simply
   * viewing a photo and closing the viewer silently took away the ability to
   * pan — the wall then only crept one tile at a time around the selection.
   * Alt is the modifier used for the rarer action instead.
   *
   * Four things must not be hijacked:
   * - the viewer, which already uses the arrows to step through photos;
   * - a text field, where the arrows move the caret;
   * - a menu, which uses them for its own navigation;
   * - any browser/app shortcut that arrives already handled.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (wall.openPhoto) return
      if (event.ctrlKey || event.metaKey) return
      if (!isPanKey(event.key)) return

      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (target?.closest('.menu-panel')) return

      if (event.altKey) {
        // Alt+arrow: move the focus to the neighbouring photo, scrolling only
        // when the new one would be off screen.
        if (!wall.state.selectedId) return
        const layoutByItem = new Map(wall.layout.items.map((item) => [item.id, item]))
        const current = layoutByItem.get(wall.state.selectedId)
        if (!current) return

        const nextId = neighbourInDirection(wall.layout.items, current, event.key)
        if (!nextId) return
        event.preventDefault()
        wall.focus(nextId)
        const next = layoutByItem.get(nextId)
        const centre = next ? { x: next.x + next.w / 2, y: next.y + next.h / 2 } : null
        if (centre && !isComfortablyVisible(wall.transform, centre, viewport)) {
          moveWithAnimation(centerOn(wall.transform, centre, viewport))
        }
        return
      }

      // Bare arrow: pan the whole wall, always.
      event.preventDefault()
      moveWithAnimation(panByKey(wall.transform, event.key, viewport, event.shiftKey))
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moveWithAnimation, viewport, wall])

  return (
    <div className="app" ref={viewport.ref}>
      <Toolbar
        dir={wall.state.dir}
        layout={wall.state.layout}
        sort={wall.state.sort}
        filtersOpen={filtersOpen}
        busy={wall.busy}
        visibleCount={wall.visiblePhotos.length}
        totalCount={wall.state.photos.length}
        onChooseFolder={wall.chooseFolder}
        onLayoutChange={wall.setLayout}
        onSortChange={wall.setSort}
        onToggleFilters={() => setFiltersOpen((open) => !open)}
      />

      {filtersOpen ? (
        <FilterPanel
          filters={wall.state.filters}
          photos={wall.state.photos}
          onChange={wall.setFilters}
          onReset={wall.resetFilters}
        />
      ) : null}

      {wall.state.status === 'error' ? (
        <div className="banner error" role="alert">
          {wall.state.errorMessage}
          <button type="button" className="button ghost" onClick={wall.chooseFolder}>
            {t('app.errorRetry')}
          </button>
        </div>
      ) : null}

      {wall.state.status === 'idle' && wall.state.photos.length === 0 ? (
        <div className="empty-state">
          <h1>{t('app.emptyTitle')}</h1>
          <p>{t('app.emptyBody')}</p>
          <button type="button" className="button primary" onClick={wall.chooseFolder}>
            {t('app.emptyAction')}
          </button>
        </div>
      ) : (
        <Wall
          ref={wallRef}
          layout={wall.layout}
          photos={wall.visiblePhotos}
          thumbUrls={wall.thumbUrls}
          transform={wall.transform}
          viewport={{ width: viewport.width, height: viewport.height }}
          square={wall.state.layout === 'square'}
          selectedId={wall.state.selectedId}
          handlers={handlers}
          animate={animate}
        />
      )}

      {wall.openPhoto ? (
        <Viewer
          photo={wall.openPhoto}
          previewUrl={visibleUrl}
          onClose={wall.closeViewer}
          onPrev={() => wall.step(-1)}
          onNext={() => wall.step(1)}
          onReveal={() => void window.photoStream.revealInFolder(wall.openPhoto!.path)}
        />
      ) : null}
    </div>
  )
}
