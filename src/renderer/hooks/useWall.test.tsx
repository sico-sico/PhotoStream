// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Photo, Settings, ThumbLevel } from '@shared/types'
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
      expect(api.requestThumbs).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'a' })],
        expect.any(String)
      )
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

    it('does not let a slow lower-quality result overwrite a sharper one', async () => {
      // Zoom in, then in again: the `wall` encode may finish after `full`.
      // Accepting it would visibly blur a tile that was already sharp.
      installApi()
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await act(async () => {
        emitThumbReady(['a', 'pic://photo/a.jpg', 'full'])
      })
      expect(result.current.thumbUrls.a).toBe('pic://photo/a.jpg')

      await act(async () => {
        emitThumbReady(['a', 'pic://thumb/a-wall.webp', 'wall'])
      })
      // Still the sharp one.
      expect(result.current.thumbUrls.a).toBe('pic://photo/a.jpg')
    })

    it('accepts a sharper result that arrives after a blurry one', async () => {
      installApi()
      api.openDirectory.mockResolvedValue({ dir: '/photos', photos: [photo('a')], skipped: 0, durationMs: 1 })

      const { result } = renderHook(() => useWall(viewport))
      await act(async () => {
        await result.current.chooseFolder()
      })

      await act(async () => {
        emitThumbReady(['a', 'pic://thumb/a-wall.webp', 'wall'])
      })
      expect(result.current.thumbUrls.a).toBe('pic://thumb/a-wall.webp')

      await act(async () => {
        emitThumbReady(['a', 'pic://photo/a.jpg', 'full'])
      })
      expect(result.current.thumbUrls.a).toBe('pic://photo/a.jpg')
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

  describe('fitToView', () => {
    it('frames the content inside the viewport', async () => {
      api.openDirectory.mockResolvedValue({
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
