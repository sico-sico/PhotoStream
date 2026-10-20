// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { OpenDroppedResult, Photo, Settings, ThumbLevel } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useWall } from './useWall'

/**
 * `useWall` is the only place that sequences IPC with React state, so it is
 * tested against a fake `window.photoStream` rather than the real bridge.
 * Every decision it makes (filtering, layout, LOD, selection) delegates to a
 * tested pure module; these tests cover the wiring and the persistence rules.
 */

function photo(id: string, takenAt = '2020-01-01', name = `${id}.jpg`): Photo {
  return {
    id,
    path: `/photos/${name}`,
    name,
    width: 100,
    height: 100,
    takenAt,
    dateSource: takenAt ? 'exif' : 'none',
    mtimeMs: 0,
    sizeBytes: 0
  }
}

interface FakeApi {
  loadSettings: ReturnType<typeof vi.fn>
  saveSettings: ReturnType<typeof vi.fn>
  openDirectory: ReturnType<typeof vi.fn>
  openDropped: ReturnType<typeof vi.fn>
  pickDirectory: ReturnType<typeof vi.fn>
  thumbUrl: ReturnType<typeof vi.fn>
  requestThumbs: ReturnType<typeof vi.fn>
  onThumbReady: ReturnType<typeof vi.fn>
  revealInFolder: ReturnType<typeof vi.fn>
  appInfo: ReturnType<typeof vi.fn>
  minimize: ReturnType<typeof vi.fn>
  toggleMaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  onWindowState: ReturnType<typeof vi.fn>
  onPhotosChanged: ReturnType<typeof vi.fn>
  onOpenExternal: ReturnType<typeof vi.fn>
  onThumbProgress: ReturnType<typeof vi.fn>
}

let api: FakeApi
let photoListener: ((payload: unknown) => void) | null
let externalListener: ((path: string) => void) | null
let progressListener: ((payload: { done: number; total: number }) => void) | null
/** Push a finished rendition into the hook, as the main process would. */
let emitThumbReady: (entry: [string, string, ThumbLevel]) => void = () => {}
/** Renditions produced before the hook subscribed; replayed on subscribe. */
let readyQueue: Array<[string, string, ThumbLevel]> = []

function installApi(settings: Partial<Settings> = {}): void {
  photoListener = null
  externalListener = null
  progressListener = null
  readyQueue = []
  emitThumbReady = (entry) => readyQueue.push(entry)

  api = {
    loadSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...settings }),
    saveSettings: vi.fn().mockImplementation(async (value: Settings) => value),
    openDirectory: vi.fn().mockResolvedValue({ dir: '/photos', photos: [], skipped: 0, durationMs: 1 }),
    openDropped: vi.fn().mockResolvedValue({ dir: '/photos', photos: [], skipped: 0, durationMs: 1, photo: '' }),
    pickDirectory: vi.fn().mockResolvedValue('/photos'),
    thumbUrl: vi.fn().mockImplementation(async (p: Photo, level: string) => `pic://thumb/${p.id}-${level}.webp`),
    // Streams results back through `onThumbReady`, exactly like the real bridge.
    requestThumbs: vi.fn().mockImplementation(async (photos: Photo[], level: ThumbLevel) => {
      for (const p of photos) emitThumbReady([p.id, `pic://thumb/${p.id}-${level}.webp`, level])
    }),
    onThumbReady: vi.fn().mockImplementation((listener: (entry: [string, string, ThumbLevel]) => void) => {
      // Replay anything that finished before this subscription existed.
      const backlog = readyQueue
      readyQueue = []
      emitThumbReady = listener
      for (const entry of backlog) listener(entry)
      return () => {
        emitThumbReady = () => {}
      }
    }),
    revealInFolder: vi.fn(),
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onWindowState: vi.fn().mockReturnValue(() => {}),
    appInfo: vi.fn().mockResolvedValue({
      version: '0',
      dataDir: '',
      thumbCacheDir: '',
      systemLocales: [],
      electron: '0',
      chromium: '0'
    }),
    onPhotosChanged: vi.fn().mockImplementation((listener: (payload: unknown) => void) => {
      photoListener = listener
      return () => {
        photoListener = null
      }
    }),
    onOpenExternal: vi.fn().mockImplementation((listener: (path: string) => void) => {
      externalListener = listener
      return () => {
        externalListener = null
      }
    }),
    onThumbProgress: vi.fn().mockImplementation((listener: (payload: { done: number; total: number }) => void) => {
      progressListener = listener
      return () => {
        progressListener = null
      }
    })
  }

  Object.defineProperty(window, 'photoStream', { value: api, writable: true, configurable: true })
}

const viewport = { width: 1200, height: 800 }

/** A promise whose settlement the test controls, for ordering two scans. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  installApi()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useWall', () => {
  describe('initial load', () => {
    it('applies stored layout and filters', async () => {
      installApi({ layout: 'masonry', filters: { from: '', to: '', text: 'kyoto' } })
      const { result } = renderHook(() => useWall(viewport))

      await waitFor(() => expect(result.current.state.layout).toBe('masonry'))
      expect(result.current.state.filters.text).toBe('kyoto')
    })

    it('restores the stored locale', async () => {
      installApi({ locale: 'fr' })
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(result.current.state.locale).toBe('fr'))
    })

    it('reopens the last directory', async () => {
      installApi({ lastDir: '/last' })
      renderHook(() => useWall(viewport))
      // The preference travels with the call, so switching the subfolder setting
      // and re-opening takes effect without restarting the app.
      await waitFor(() => expect(api.openDirectory).toHaveBeenCalledWith('/last', false))
    })

    it('does not let the restored folder win over a drop made during startup', async () => {
      // `loadSettings` is async, so a folder dragged in right after launch can
      // arrive before the restore has decided to reopen `lastDir`. Whichever
      // resolves later would otherwise win, which is why a quick drop
      // occasionally appeared to do nothing: the wall restored the previous
      // folder over it.
      installApi({ lastDir: '/last' })
      const loading = deferred<Settings>()
      api.loadSettings.mockReturnValue(loading.promise)

      const { result } = renderHook(() => useWall(viewport))

      // The user drops a folder before settings have loaded.
      api.openDropped.mockResolvedValue({
        dir: 'D:/dropped',
        photos: [photo('d')],
        skipped: 0,
        durationMs: 1,
        photo: ''
      })
      await act(async () => {
        await result.current.openDropped('D:/dropped')
      })
      expect(result.current.state.dir).toBe('D:/dropped')

      // Settings now arrive and try to reopen the remembered folder.
      await act(async () => {
        loading.resolve({ ...DEFAULT_SETTINGS, lastDir: '/last' })
        await loading.promise
      })

      expect(result.current.state.dir).toBe('D:/dropped')
      expect(api.openDirectory).not.toHaveBeenCalledWith('/last', expect.anything())
    })

    it('still restores the last folder when nothing was dropped', async () => {
      // The guard above must not disable the restore itself.
      installApi({ lastDir: '/last' })
      api.openDirectory.mockResolvedValue({ dir: '/last', photos: [photo('l')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(result.current.state.dir).toBe('/last'))
    })

    it('does not reopen anything when no directory was stored', async () => {
      renderHook(() => useWall(viewport))
      await waitFor(() => expect(api.loadSettings).toHaveBeenCalled())
      expect(api.openDirectory).not.toHaveBeenCalled()
    })

    it('falls back to defaults when loading throws', async () => {
      installApi()
      api.loadSettings.mockRejectedValue(new Error('disk gone'))

      const { result } = renderHook(() => useWall(viewport))
      // The hook must still become usable rather than staying in a loading limbo.
      await waitFor(() => expect(result.current.state.status).toBe('idle'))
      expect(result.current.state.layout).toBe(DEFAULT_SETTINGS.layout)
    })
  })

  describe('opening a directory', () => {
    it('stores the scan result', async () => {
      api.openDirectory.mockResolvedValue({
        dir: '/photos',
        photos: [photo('b', '2021-01-01'), photo('a', '2019-01-01')],
        skipped: 0,
        durationMs: 5
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      expect(result.current.state.dir).toBe('/photos')
      expect(result.current.state.status).toBe('ready')
      // Newest first: the wall opens on the most recent photo.
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['b', 'a'])
    })

    it('focuses and opens the photo a drop named', async () => {
      api.openDropped.mockResolvedValue({
        dir: '/photos',
        // Ids are lower-cased paths in production; matching relies on that.
        photos: [photo('/photos/b.jpg'), photo('/photos/a.jpg')],
        skipped: 0,
        durationMs: 5,
        photo: '/photos/a.jpg'
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.openDropped('/photos/a.jpg')
      })

      // Dropping one picture means "show me this picture", not "show me the
      // newest one in its folder".
      expect(result.current.state.selectedId).toBe('/photos/a.jpg')
      expect(result.current.openPhoto?.id).toBe('/photos/a.jpg')
    })

    it('does not open the viewer when a folder was dropped', async () => {
      api.openDropped.mockResolvedValue({
        dir: '/photos',
        photos: [photo('b', '2020-01-01', 'b.jpg')],
        skipped: 0,
        durationMs: 5,
        photo: ''
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.openDropped('/photos')
      })

      expect(result.current.state.status).toBe('ready')
      expect(result.current.openPhoto).toBeNull()
    })

    it('ignores a dropped photo that is not in the scan result', async () => {
      // The file can vanish between resolving and scanning; the wall should
      // still open rather than fail on the missing tile.
      api.openDropped.mockResolvedValue({
        dir: '/photos',
        photos: [photo('b', '2020-01-01', 'b.jpg')],
        skipped: 0,
        durationMs: 5,
        photo: '/photos/gone.jpg'
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.openDropped('/photos/gone.jpg')
      })

      expect(result.current.state.status).toBe('ready')
      expect(result.current.openPhoto).toBeNull()
    })

    it('opens a photo handed over by "Open with"', async () => {
      api.openDropped.mockResolvedValue({
        dir: '/photos',
        photos: [photo('/photos/a.jpg')],
        skipped: 0,
        durationMs: 5,
        photo: '/photos/a.jpg'
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        externalListener?.('/photos/a.jpg')
      })

      // Same behaviour as a drop, by construction: the main process routes both
      // through the same notification.
      await waitFor(() => expect(result.current.openPhoto?.id).toBe('/photos/a.jpg'))
    })

    it('reorders the wall when the sort mode changes', async () => {
      api.openDirectory.mockResolvedValue({
        dir: '/photos',
        photos: [photo('a', '2019-01-01'), photo('b', '2021-01-01')],
        skipped: 0,
        durationMs: 5
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['b', 'a'])

      act(() => {
        result.current.setSort('taken-asc')
      })
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['a', 'b'])
    })

    it('reports a scan failure without clearing the app', async () => {
      api.openDirectory.mockRejectedValue(new Error('permission denied'))

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      expect(result.current.state.status).toBe('error')
      expect(result.current.state.errorMessage).toContain('permission denied')
    })

    it('does nothing when the user cancels the picker', async () => {
      api.pickDirectory.mockResolvedValue(null)

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      expect(api.openDirectory).not.toHaveBeenCalled()
      expect(result.current.state.status).toBe('idle')
    })

    it('passes the active locale to the folder dialog', async () => {
      installApi({ locale: 'zh-CN' })
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(result.current.state.locale).toBe('zh-CN'))

      await act(async () => {
        await result.current.chooseFolder()
      })

      expect(api.pickDirectory).toHaveBeenCalledWith('zh-CN')
    })
  })

  describe('overlapping opens', () => {
    it('shows the folder opened last, even if its scan resolves first', async () => {
      // Dragging three folders onto the window fires three opens in a row. The
      // scans finish in whatever order the disk decides, and the wall must show
      // the folder the user dropped last 鈥?not the one that happened to finish
      // last.
      const slowA = deferred<OpenDroppedResult>()
      const fastB = deferred<OpenDroppedResult>()
      api.openDropped
        .mockImplementationOnce(() => slowA.promise)
        .mockImplementationOnce(() => fastB.promise)

      const { result } = renderHook(() => useWall(viewport))

      let first: Promise<void>
      act(() => {
        first = result.current.openDropped('D:/a')
        void result.current.openDropped('D:/b')
      })

      // The second drop is small and lands first.
      await act(async () => {
        fastB.resolve({ dir: 'D:/b', photos: [photo('b')], skipped: 0, durationMs: 1, photo: '' })
        await fastB.promise
      })
      expect(result.current.state.dir).toBe('D:/b')

      // The first drop then lands. It is stale: the user has moved on.
      await act(async () => {
        slowA.resolve({ dir: 'D:/a', photos: [photo('a')], skipped: 0, durationMs: 1, photo: '' })
        await first!
      })

      expect(result.current.state.dir).toBe('D:/b')
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['b'])
    })

    it('does not leave the wall stuck in a scanning state when a stale scan errors', async () => {
      // The abandoned scan can fail after the user moved on 鈥?a folder is
      // deleted, a drive is unplugged. Reporting that error would replace a
      // perfectly good wall with an error message about a folder nobody asked
      // for any more.
      const slowA = deferred<OpenDroppedResult>()
      const fastB = deferred<OpenDroppedResult>()
      api.openDropped
        .mockImplementationOnce(() => slowA.promise)
        .mockImplementationOnce(() => fastB.promise)

      const { result } = renderHook(() => useWall(viewport))

      let first: Promise<void>
      act(() => {
        first = result.current.openDropped('D:/a')
        void result.current.openDropped('D:/b')
      })

      await act(async () => {
        fastB.resolve({ dir: 'D:/b', photos: [photo('b')], skipped: 0, durationMs: 1, photo: '' })
        await fastB.promise
      })

      await act(async () => {
        slowA.reject(new Error('EACCES: permission denied'))
        await first!.catch(() => undefined)
      })

      expect(result.current.state.status).toBe('ready')
      expect(result.current.state.dir).toBe('D:/b')
      expect(result.current.state.errorMessage).toBe('')
    })

    it('lets the same folder be reopened after a stale scan resolved it', async () => {
      // Guards the obvious wrong fix: an "ignore everything but the newest"
      // flag that never clears would make the app unresponsive to every later
      // open once a single scan was superseded.
      const slowA = deferred<OpenDroppedResult>()
      const fastB = deferred<OpenDroppedResult>()
      const again = deferred<OpenDroppedResult>()
      api.openDropped
        .mockImplementationOnce(() => slowA.promise)
        .mockImplementationOnce(() => fastB.promise)
        .mockImplementationOnce(() => again.promise)

      const { result } = renderHook(() => useWall(viewport))

      let first: Promise<void>
      act(() => {
        first = result.current.openDropped('D:/a')
        void result.current.openDropped('D:/b')
      })
      await act(async () => {
        fastB.resolve({ dir: 'D:/b', photos: [photo('b')], skipped: 0, durationMs: 1, photo: '' })
        await fastB.promise
        slowA.resolve({ dir: 'D:/a', photos: [photo('a')], skipped: 0, durationMs: 1, photo: '' })
        await first!
      })

      let third: Promise<void>
      act(() => {
        third = result.current.openDropped('D:/c')
      })
      await act(async () => {
        again.resolve({ dir: 'D:/c', photos: [photo('c')], skipped: 0, durationMs: 1, photo: '' })
        await third!
      })

      expect(result.current.state.dir).toBe('D:/c')
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['c'])
    })
  })

  describe('derived state', () => {
    async function openWith(photos: Photo[]): Promise<ReturnType<typeof renderHook<ReturnType<typeof useWall>, unknown>>> {
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos, skipped: 0, durationMs: 1 })
      const hook = renderHook(() => useWall(viewport))
      await act(async () => {
        await hook.result.current.chooseFolder()
      })
      return hook
    }

    it('applies filters to the visible set', async () => {
      const hook = await openWith([photo('a', '2019-07-14', '2019 Kyoto.jpg'), photo('b', '2024-03-11', '2024 Paris.jpg')])

      act(() => {
        hook.result.current.setFilters({ from: '', to: '', text: 'kyoto' })
      })

      expect(hook.result.current.visiblePhotos.map((p) => p.id)).toEqual(['a'])
      // The full collection is retained so clearing the filter restores it.
      expect(hook.result.current.state.photos).toHaveLength(2)
    })

    it('rebuilds the layout when the layout mode changes', async () => {
      const hook = await openWith([photo('a'), photo('b')])
      const gridWidth = hook.result.current.layout.items.length

      act(() => {
        hook.result.current.setLayout('square')
      })

      expect(gridWidth).toBe(2)
      expect(hook.result.current.state.layout).toBe('square')
      expect(hook.result.current.layout.items).toHaveLength(2)
    })

    it('resets filters back to the full set', async () => {
      const hook = await openWith([photo('a', '2019-07-14', 'Kyoto.jpg'), photo('b')])

      act(() => {
        hook.result.current.setFilters({ from: '', to: '', text: 'kyoto' })
      })
      expect(hook.result.current.visiblePhotos).toHaveLength(1)

      act(() => {
        hook.result.current.resetFilters()
      })
      expect(hook.result.current.visiblePhotos).toHaveLength(2)
    })

    it('exposes the selected photo', async () => {
      const hook = await openWith([photo('a'), photo('b')])

      act(() => {
        hook.result.current.select('b')
      })
      expect(hook.result.current.openPhoto?.id).toBe('b')

      act(() => {
        hook.result.current.select(null)
      })
      expect(hook.result.current.openPhoto).toBeNull()
    })

    it('steps through the visible order', async () => {
      const hook = await openWith([photo('a', '2019-01-01'), photo('b', '2020-01-01'), photo('c', '2021-01-01')])

      // Newest first, so the visible order is c, b, a.
      act(() => {
        hook.result.current.select('c')
      })
      act(() => {
        hook.result.current.step(1)
      })
      expect(hook.result.current.openPhoto?.id).toBe('b')
    })
  })

  describe('thumbnails', () => {
    it('requests thumbnails for visible photos in one batch', async () => {
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await waitFor(() => expect(result.current.thumbUrls.a).toContain('pic://thumb/'))
      // One round-trip per pass, not one per photo.
      expect(api.requestThumbs).toHaveBeenCalledTimes(1)
      // `interactive` when idle: these are the tiles the user is looking at.
      expect(api.requestThumbs).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'a' })],
        expect.any(String),
        'interactive'
      )
    })

    it('asks for nothing from the viewport while a scroll target is pending', async () => {
      // A drag brings a new band into view on every pointer event. Requesting
      // each of those filled the four-slot encode queue with bands the thumb had
      // already swept past, and the destination the drag was heading for sat
      // behind all of them — a measured drag left all 84 mounted tiles blank for
      // the whole 5 s window. Only the destination is requested while scrolling.
      const many = Array.from({ length: 400 }, (_, i) => photo(`p${i}`, '2020-01-01', `${i}.jpg`))
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: many, skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })
      await waitFor(() => expect(api.requestThumbs).toHaveBeenCalled())

      api.requestThumbs.mockClear()
      // Announce a destination, as the scrollbar does on pointerdown.
      act(() => result.current.prefetchForScroll(3000))
      // Zooming asks for a different rendition level for everything on screen,
      // which is the request this effect would otherwise make.
      act(() => result.current.setTransform((t) => ({ ...t, scale: 2 })))

      // Let any pending timer run.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
      })

      // Whatever went out is the prefetch, never a viewport batch.
      for (const call of api.requestThumbs.mock.calls) {
        expect(call[2]).toBe('background')
      }
    })

    it('returns to asking for the viewport once the scroll has settled', async () => {
      // The pause must not stick: after the jump lands, the visible band is the
      // one that matters and has to load at interactive priority.
      const many = Array.from({ length: 400 }, (_, i) => photo(`p${i}`, '2020-01-01', `${i}.jpg`))
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: many, skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })
      await waitFor(() => expect(api.requestThumbs).toHaveBeenCalled())

      act(() => result.current.prefetchForScroll(3000))
      // Wait past SCROLL_SETTLE_MS so the wall leaves "scrolling" mode.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
      })

      api.requestThumbs.mockClear()
      act(() => result.current.setTransform((t) => ({ ...t, scale: 2 })))

      await waitFor(() => expect(api.requestThumbs).toHaveBeenCalled())
      const prios = api.requestThumbs.mock.calls.map((call) => call[2])
      expect(prios).toContain('interactive')
    })

    it('only asks for photos inside the viewport', async () => {
      // Photos are laid out vertically; a viewport-sized window can only reach
      // the first few. Requesting all of them is what made large folders slow.
      const many = Array.from({ length: 400 }, (_, i) => photo(`p${i}`, '2020-01-01', `${i}.jpg`))
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: many, skipped: 0, durationMs: 1 })
      api.requestThumbs.mockResolvedValue(undefined)

      const { result } = renderHook(() => useWall({ width: 1200, height: 800 }))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await waitFor(() => expect(api.requestThumbs).toHaveBeenCalled())
      const requested = api.requestThumbs.mock.calls.flatMap(([photos]) => photos as Photo[])
      expect(requested.length).toBeGreaterThan(0)
      expect(requested.length).toBeLessThan(many.length)
    })

    it('shows the rendition that matches the current zoom, not the sharpest ever seen', async () => {
      // The rule is "what the zoom calls for", not "the best so far". Keeping the
      // sharpest ever received pinned every visited tile to a multi-megapixel
      // original even after zooming back out: measured at 1239 MB in the
      // renderer versus 142 MB at rest.
      installApi()
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await act(async () => {
        emitThumbReady(['a', 'pic://thumb/a-wall.webp', 'wall'])
      })
      await act(async () => {
        emitThumbReady(['a', 'pic://photo/a.jpg', 'full'])
      })

      // At the fitted zoom the wall wants `wall`, so that is what it shows 鈥?
      // the original is recorded but not displayed.
      expect(result.current.thumbLevel).toBe('wall')
      expect(result.current.thumbUrls.a).toBe('pic://thumb/a-wall.webp')
    })

    it('switches to the sharper rendition once the zoom calls for it', async () => {
      installApi()
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await act(async () => {
        emitThumbReady(['a', 'pic://thumb/a-wall.webp', 'wall'])
        emitThumbReady(['a', 'pic://thumb/a-zoom.webp', 'zoom'])
      })
      expect(result.current.thumbUrls.a).toBe('pic://thumb/a-wall.webp')

      // Zoom in far enough to cross into the `zoom` band.
      act(() => {
        result.current.setTransform({ scale: 3, x: 0, y: 0 })
      })
      await waitFor(() => expect(result.current.thumbLevel).toBe('zoom'))
      expect(result.current.thumbUrls.a).toBe('pic://thumb/a-zoom.webp')
    })

    it('falls back to a rendition that already arrived while the right one loads', async () => {
      // A blank tile is worse than a slightly soft one, so display falls back
      // through the levels that exist instead of clearing the slot.
      installApi()
      // `requestThumbs` normally streams a result straight back; suppress that
      // so the test controls exactly which renditions have arrived.
      api.requestThumbs.mockResolvedValue(undefined)
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      // Only the small rendition has arrived.
      await act(async () => {
        emitThumbReady(['a', 'pic://thumb/a-wall.webp', 'wall'])
      })
      act(() => {
        result.current.setTransform({ scale: 3, x: 0, y: 0 })
      })

      await waitFor(() => expect(result.current.thumbLevel).toBe('zoom'))
      expect(result.current.thumbUrls.a).toBe('pic://thumb/a-wall.webp')
    })

    it('keeps the wall usable when a thumbnail request fails', async () => {
      api.requestThumbs.mockRejectedValue(new Error('encode failed'))
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await waitFor(() => expect(api.requestThumbs).toHaveBeenCalled())
      // No URL, but the tile stays and the photo is still visible.
      expect(result.current.thumbUrls.a).toBeUndefined()
      expect(result.current.visiblePhotos).toHaveLength(1)
    })
  })

  describe('persistence', () => {
    it('restores the remembered EXIF panel choice', async () => {
      // The preference is a browsing style, so it has to survive a restart. It
      // was never written before, which is why the panel always came back
      // closed on the next launch.
      installApi({ viewerInfo: true })
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(result.current.state.viewerInfo).toBe(true))
    })

    it('saves the EXIF panel choice', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(api.loadSettings).toHaveBeenCalled())

      act(() => {
        result.current.setViewerInfo(true)
      })

      await waitFor(() => {
        const saved = api.saveSettings.mock.calls.at(-1)?.[0] as Settings | undefined
        expect(saved?.viewerInfo).toBe(true)
      })
    })

    it('saves layout changes', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(api.loadSettings).toHaveBeenCalled())

      act(() => {
        result.current.setLayout('masonry')
      })

      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const saved = api.saveSettings.mock.calls.at(-1)![0] as Settings
      expect(saved.layout).toBe('masonry')
    })

    it('restores the cache budget', async () => {
      installApi({ cacheBudgetMb: 4096 })
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(result.current.state.cacheBudgetMb).toBe(4096))
    })

    it('saves a cache limit, including the unlimited value', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(api.loadSettings).toHaveBeenCalled())

      act(() => {
        result.current.setCacheBudgetMb(2048)
      })
      await waitFor(() => {
        const saved = api.saveSettings.mock.calls.at(-1)?.[0] as Settings | undefined
        expect(saved?.cacheBudgetMb).toBe(2048)
      })

      // `0` has to reach the file as itself; dropping it as falsy would turn
      // "unlimited" back into whatever default the writer applies.
      act(() => {
        result.current.setCacheBudgetMb(0)
      })
      await waitFor(() => {
        const saved = api.saveSettings.mock.calls.at(-1)?.[0] as Settings | undefined
        expect(saved?.cacheBudgetMb).toBe(0)
      })
    })

    it('saves the locale change', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(api.loadSettings).toHaveBeenCalled())

      act(() => {
        result.current.setLocale('fr')
      })

      await waitFor(() => {
        const saved = api.saveSettings.mock.calls.at(-1)?.[0] as Settings | undefined
        expect(saved?.locale).toBe('fr')
      })
    })

    it('does not overwrite settings before the initial load finishes', async () => {
      // A write racing the read would replace the user's stored folder and
      // language with defaults. This is a real bug that shipped once: every
      // launch reset layout, language and last folder.
      let release: ((value: Settings) => void) | null = null
      api.loadSettings.mockImplementation(
        () =>
          new Promise<Settings>((resolve) => {
            release = resolve
          })
      )

      const { result } = renderHook(() => useWall(viewport))

      // Force several state changes while the read is still pending.
      await act(async () => {
        result.current.setLayout('square')
      })
      expect(api.saveSettings).not.toHaveBeenCalled()

      await act(async () => {
        release?.({ ...DEFAULT_SETTINGS, lastDir: '', layout: 'masonry', locale: 'fr' })
      })

      // Once restored, the stored values win and are then persisted as-is.
      await waitFor(() => expect(result.current.state.locale).toBe('fr'))
      expect(result.current.state.layout).toBe('masonry')

      const saved = api.saveSettings.mock.calls.at(-1)?.[0] as Settings | undefined
      expect(saved?.layout).toBe('masonry')
      expect(saved?.locale).toBe('fr')
    })

    it('never writes defaults as the very first save', async () => {
      // The specific failure mode: the first `saveSettings` call must already
      // carry the restored values, not the mount-time defaults.
      installApi({ layout: 'square', locale: 'fr' })
      const { result } = renderHook(() => useWall(viewport))

      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
      const first = api.saveSettings.mock.calls[0][0] as Settings
      expect(first.locale).toBe('fr')
      expect(first.layout).toBe('square')
      expect(result.current.state.locale).toBe('fr')
    })
  })

  describe('live updates', () => {
    it('applies a watcher delta', async () => {
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })
      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      act(() => {
        photoListener?.({ kind: 'delta', photos: [photo('a'), photo('b')] })
      })

      // Both photos share a date, so the name order decides; the default
      // direction is newest first, which reverses names within a day.
      expect(result.current.visiblePhotos.map((p) => p.id)).toEqual(['b', 'a'])
    })

    it('surfaces a watcher error', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(photoListener).not.toBeNull())

      act(() => {
        photoListener?.({ kind: 'error', message: 'watch failed' })
      })

      expect(result.current.state.errorMessage).toBe('watch failed')
    })

    it('ignores unknown payloads', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(photoListener).not.toBeNull())

      act(() => {
        photoListener?.({ kind: 'something-else' })
        photoListener?.(null)
      })

      expect(result.current.state.status).toBe('idle')
    })

    it('tracks thumbnail progress', async () => {
      const { result } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(progressListener).not.toBeNull())

      act(() => {
        progressListener?.({ done: 2, total: 8 })
      })

      expect(result.current.progress).toEqual({ done: 2, total: 8 })
    })

    it('unsubscribes on unmount', async () => {
      const { unmount } = renderHook(() => useWall(viewport))
      await waitFor(() => expect(photoListener).not.toBeNull())

      unmount()
      expect(photoListener).toBeNull()
      expect(progressListener).toBeNull()
    })
  })

  describe('openSelected', () => {
    it('opens the focused photo without touching the selection', async () => {
      // Enter/Space on the wall is the keyboard equivalent of clicking the
      // tile Alt+arrows walked to, so it must open that exact photo.
      api.openDirectory.mockResolvedValue({
        dir: '/photos',
        photos: [photo('a', '2020-01-01', 'a.jpg'), photo('b', '2021-01-01', 'b.jpg')],
        skipped: 0,
        durationMs: 1
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      act(() => {
        result.current.focus('a')
      })
      expect(result.current.openPhoto).toBeNull()

      act(() => {
        result.current.openSelected()
      })

      expect(result.current.openPhoto?.id).toBe('a')
    })

    it('does nothing when no photo is focused', () => {
      const { result } = renderHook(() => useWall(viewport))

      act(() => {
        result.current.openSelected()
      })

      expect(result.current.openPhoto).toBeNull()
    })
  })

  describe('fitToView', () => {
    it('frames the content inside the viewport', async () => {      api.openDirectory.mockResolvedValue({
        dir: '/photos',
        photos: Array.from({ length: 4 }, (_, i) => photo(`p${i}`)),
        skipped: 0,
        durationMs: 1
      })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      act(() => {
        result.current.fitToView({ width: 1000, height: 700 })
      })

      const { transform } = result.current
      expect(transform.scale).toBeGreaterThan(0)
      expect(Number.isFinite(transform.x)).toBe(true)
      expect(Number.isFinite(transform.y)).toBe(true)
    })
  })
})
