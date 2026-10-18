import { useEffect, useMemo, useRef, useState } from 'react'
import { FilterPanel } from './components/FilterPanel'
import { Toolbar } from './components/Toolbar'
import { Viewer } from './components/Viewer'
import { Wall } from './components/Wall'
import { usePanZoom } from './hooks/usePanZoom'
import { useWall } from './hooks/useWall'
import { I18nProvider } from './i18n/I18nProvider'
import { useI18n } from './i18n/context'
import { fitTransform } from '@shared/transform'
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

  const handlers = usePanZoom(wall.setTransform, {
    onItemClick: (id) => wall.select(id),
    onBackgroundClick: () => setFiltersOpen(false)
  })
  // Frame the wall the first time it has content, and again when the folder
  // or layout changes, so the user never starts staring at empty space.
  const fitKey = `${wall.state.dir}|${wall.state.layout}|${wall.layout.width}|${wall.layout.height}`
  useEffect(() => {
    if (wall.layout.items.length === 0) return
    if (fittedFor.current === fitKey) return
    fittedFor.current = fitKey
    wall.setTransform(
      fitTransform(wall.layout.width, wall.layout.height, viewport.width, viewport.height, { maxScale: 1 })
    )
  }, [fitKey, viewport.height, viewport.width, wall])

  const visibleUrl = useMemo(
    () => (wall.openPhoto ? wall.thumbUrls[wall.openPhoto.id] : undefined),
    [wall.openPhoto, wall.thumbUrls]
  )

  return (
    <div className="app" ref={viewport.ref}>
      <Toolbar
        dir={wall.state.dir}
        layout={wall.state.layout}
        filtersOpen={filtersOpen}
        progress={wall.progress}
        busy={wall.busy}
        visibleCount={wall.visiblePhotos.length}
        totalCount={wall.state.photos.length}
        onChooseFolder={wall.chooseFolder}
        onLayoutChange={wall.setLayout}
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
          layout={wall.layout}
          photos={wall.visiblePhotos}
          thumbUrls={wall.thumbUrls}
          transform={wall.transform}
          square={wall.state.layout === 'square'}
          selectedId={wall.state.selectedId}
          handlers={handlers}
        />
      )}

      {wall.openPhoto ? (
        <Viewer
          photo={wall.openPhoto}
          previewUrl={visibleUrl}
          onClose={() => wall.select(null)}
          onPrev={() => wall.step(-1)}
          onNext={() => wall.step(1)}
          onReveal={() => void window.photoStream.revealInFolder(wall.openPhoto!.path)}
        />
      ) : null}
    </div>
  )
}
