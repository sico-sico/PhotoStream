import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, relative as relativePath, resolve, sep } from 'node:path'
import type { AppInfo, CacheStats, Photo, ScanResult, Settings, ThumbLevel } from '../shared/types'
import { IPC } from '../shared/ipc'
import { scanDirectory } from './scanner'
import { photoId } from './scanner'
import { resolveOpenTarget } from './drop'
import type { OpenDroppedResult } from '../shared/types'
import { ensureThumbnail, ensureThumbnails, type ThumbRequest } from './thumbnails'
import type { ThumbPriority } from '../shared/types'
import { loadSettings, saveSettings } from './settings-store'
import { watchDirectory, type DirectoryWatcher, type RawWatchEvent } from './watcher'
import { thumbUrl, photoUrl } from './protocol'
import { resolvePhotoDate } from '../shared/date'
import { findPhoto, removePhoto, sortPhotos, upsertPhoto } from '../shared/photoStore'
import { readImageMetadata, readFullExif } from './metadata'
import type { CachedPhotoRow, MetadataCache } from './metadata-cache'
import type { ThumbCache } from './cache-maintenance'
import type { RawExif } from '../shared/exif'
import { locales } from '../shared/i18n'

/**
 * A speculative scan, started before the renderer asks for it.
 */
interface PrefetchedScan {
  /** As the caller passed it, for exact comparison with the later request. */
  request: string
  /** Absolute form, for comparison against a differently written path. */
  absolute: string
  recursive: boolean
  generation: number
  controller: AbortController
  result: Promise<ScanResult>
  /**
   * Whether the scan has finished.
   *
   * An `open` that adopts this scan still seeds the wall from the cache, unless
   * the scan is already done — in which case the seed would only be a stale
   * copy of an answer that is already on its way.
   */
  settled: boolean
}

/**
 * Owns the currently open library: scanning, watching, thumbnail warm-up and
 * the notifications the renderer listens to.
 */
export class PhotoLibrary {
  private photos: Photo[] = []
  private dir = ''
  private watcher: DirectoryWatcher | null = null
  private thumbQueue: Promise<unknown> = Promise.resolve()
  /**
   * Incremented for every `open()`. A scan only applies its result if its token
   * is still the newest, which is what stops a slow folder from overwriting a
   * faster one the user opened after it.
   */
  private generation = 0
  /** Abort controller for the scan currently in flight, if any. */
  private scanning: AbortController | null = null
  /**
   * Signals of each scan, in the order they were started.
   *
   * Exposed for tests: an abandoned scan must be aborted, not merely ignored, or
   * dropping three folders reads EXIF for two libraries nobody will ever see.
   */
  readonly scanSignals: AbortSignal[] = []

  /** A scan started before the renderer asked; adopted by the matching `open`. */
  private prefetched: PrefetchedScan | null = null

  /**
   * Background re-checks of the folder that is already open.
   *
   * Started by `open` when it short-circuits, aborted by `claim` so they never
   * race the scan for a folder the user has actually asked for.
   */
  private readonly revalidations = new Set<AbortController>()

  /** In-flight re-checks, so `drain` can wait for them. */
  private readonly revalidationJobs = new Set<Promise<void>>()

  constructor(
    readonly thumbCacheDir: string,
    private readonly notify: (channel: string, payload: unknown) => void,
    /** Cache of parsed EXIF, keyed by path + mtime + size. */
    readonly metadataCache?: MetadataCache,
    /**
     * Called with the byte size of each rendition this library encodes.
     *
     * The cache's running total is kept from this rather than from a directory
     * walk per tile: the encoder already knows the size, and re-statting the
     * cache root after every thumbnail would cost more than the encode.
     */
    private readonly onThumbWritten?: (bytes: number) => void
  ) {}

  get directory(): string {
    return this.dir
  }

  get all(): readonly Photo[] {
    return this.photos
  }

  /**
   * Whether subfolders are scanned, and whether watcher events below the root
   * are honoured. Set on each `open()` so switching the preference and
   * re-opening the same folder takes effect.
   */
  private recursive = false

  /**
   * Claim the right to open the library.
   *
   * Called *before* anything that awaits. Resolving a dropped path does a
   * `stat`, which can be slow on a sleeping drive or a network share; claiming
   * afterwards made the token follow the order the `stat` calls finished rather
   * than the order the user dropped the folders, so dropping A then B could end
   * up showing A.
   *
   * Aborts whatever scan was already running: the user has moved on, and reading
   * metadata for a library nobody will see is pure waste.
   */
  claim(): { generation: number; signal: AbortSignal; controller: AbortController } {
    // A new claim supersedes any speculative scan: either the user has asked for
    // another folder, or this claim belongs to the prefetch itself.
    this.prefetched = null
    // Background re-checks describe the folder that was open a moment ago, so
    // they are pointless once a different one is being opened — and they would
    // compete for the disk with the scan that matters.
    for (const controller of this.revalidations) controller.abort()
    this.revalidations.clear()
    this.scanning?.abort()
    const controller = new AbortController()
    this.scanning = controller
    this.scanSignals.push(controller.signal)
    return { generation: ++this.generation, signal: controller.signal, controller }
  }

  /**
   * Scan the folder the renderer is about to ask for, before it asks.
   *
   * At startup the renderer has to mount, read the settings file and call back
   * before any scanning begins; that is window-creation time spent idle on the
   * one folder the app already knows it will open. `open()` adopts the result
   * when the request arrives, so the folder is still read exactly once.
   *
   * A prefetch is speculative: any later `claim()` (a drop, a folder picker)
   * aborts it, and a request for a different folder abandons it.
   */
  prefetch(dir: string, options: { recursive?: boolean } = {}): void {
    if (!dir || this.prefetched) return
    const recursive = options.recursive === true
    const { generation, signal, controller } = this.claim()
    const result = scanDirectory(dir, { cache: this.metadataCache, recursive, signal })
    // The user may drop another folder before the renderer ever asks for this
    // one; that abort rejects the promise with no adopter. Swallowing the
    // rejection here keeps a deliberately cancelled scan from looking like a
    // crash, while `open()` still sees the original rejection when it adopts.
    result.catch(() => undefined)
    const pending: PrefetchedScan = {
      request: dir,
      absolute: resolve(dir),
      recursive,
      generation,
      controller,
      result,
      settled: false
    }
    void result.then(
      () => {
        pending.settled = true
      },
      () => {
        pending.settled = true
      }
    )
    this.prefetched = pending
  }

  /**
   * Take the matching prefetch, if there is one, so `open` can await its result
   * instead of starting a second scan over the same files.
   */
  private takePrefetch(dir: string, recursive: boolean): PrefetchedScan | null {
    const pending = this.prefetched
    if (!pending) return null
    const matches =
      pending.generation === this.generation &&
      pending.recursive === recursive &&
      (pending.request === dir || pending.absolute === resolve(dir))
    if (!matches) {
      // Scanning a folder nobody is going to look at is exactly the waste the
      // abort machinery exists to prevent.
      this.prefetched = null
      pending.controller.abort()
      return null
    }
    this.prefetched = null
    return pending
  }

  /**
   * Open a directory: scan it, start watching, and warm thumbnails in the
   * background.
   *
   * @param options.generation from `claim`, when the caller awaited something
   *   before getting here. Omit it to claim now.
   */
  async open(
    dir: string,
    options: {
      recursive?: boolean
      generation?: number
      signal?: AbortSignal
      /**
       * Directory string the renderer used to ask for this open.
       *
       * The cached snapshot is keyed by it, so the renderer can tell which open
       * a snapshot belongs to. A dropped photo asks with a *file* path but opens
       * its folder, so the two strings differ; without this the snapshot would
       * be thrown away and the wall would stay blank until the scan finished.
       */
      announceAs?: string
    } = {}
  ): Promise<ScanResult> {
    const recursive = options.recursive === true

    /*
     * Re-opening the folder that is already open.
     *
     * The history menu, a repeated picker choice and "open the same album
     * again" all land here, and a full scan of 40 000 photos costs ~700 ms of
     * `stat` calls even with every metadata row cached — for a result the
     * watcher has been keeping current the whole time.
     *
     * What the renderer gets is the list it already has, so nothing visibly
     * happens, which is the correct outcome. The folder is still re-checked in
     * the background (`revalidate`) and a real difference is pushed as a
     * replacement, so a file added while the watcher was not looking still
     * appears.
     *
     * Only for a plain open: a drop passes a generation because it also has to
     * focus the photo, and a folder that is still being scanned has no settled
     * answer to hand back.
     */
    if (
      options.generation === undefined &&
      this.scanning === null &&
      this.watcher !== null &&
      this.photos.length > 0 &&
      this.dir === resolve(dir) &&
      this.recursive === recursive
    ) {
      this.startRevalidate()
      return { dir: this.dir, photos: this.photos, skipped: 0, durationMs: 0 }
    }

    // A startup prefetch for this exact folder and mode is already reading it;
    // awaiting that instead of claiming would abort it and pay for the files
    // twice.
    const adopted = options.generation === undefined ? this.takePrefetch(dir, recursive) : null

    // Claiming here keeps every caller that has nothing to await working. The
    // drop handler passes its own generation instead, because its token has to
    // predate the `stat` it already awaited.
    const claim = adopted === null && options.generation === undefined ? this.claim() : null
    const generation = adopted?.generation ?? claim?.generation ?? options.generation!
    const signal = adopted?.controller.signal ?? claim?.signal ?? options.signal

    this.close()
    this.recursive = recursive

    // Paint what the metadata cache already knows before touching the disk.
    //
    // The scan has to `stat` every file, which on a sleeping drive or a network
    // share is the slowest part of opening a folder; the cache answers in one
    // indexed query. Sent once, as a complete snapshot: the wall's layout is
    // derived from the whole photo set, so feeding it in pieces would re-lay
    // out and re-anchor the view on every piece.
    //
    // Read once and shared with the scan, which would otherwise ask the same
    // 40 000 rows for a second time.
    //
    // An adopted prefetch is seeded too: at startup that scan is usually still
    // running when the renderer asks, and waiting for it would be more empty
    // wall. Only a prefetch that has already finished is left alone — its
    // answer is imminent, and a seed would just be a stale copy.
    const snapshot = adopted === null ? this.metadataCache?.snapshot(resolve(dir)) : undefined
    if (adopted === null || !adopted.settled) {
      this.emitCachedSeed(options.announceAs ?? dir, dir, recursive, generation, snapshot?.rows)
    }

    const result =
      adopted?.result ??
      scanDirectory(dir, {
        cache: this.metadataCache,
        index: snapshot,
        recursive: this.recursive,
        signal
      })

    const scanned = await result

    // A later open has already taken over: this result is for a folder the user
    // moved on from. Discarding it is what makes "the last folder you dropped"
    // the one you actually see, regardless of which scan finishes first.
    if (generation !== this.generation) return scanned

    // Only the winner clears the in-flight scan, so a stale open cannot make a
    // newer one look finished.
    if (signal?.aborted !== true) this.scanning = null
    this.photos = scanned.photos
    this.dir = scanned.dir
    // `close()` above detached the previous watcher; start the new one only
    // once this scan is the winner, or an abandoned folder keeps a recursive
    // watch open for the rest of the session.
    this.watcher = this.startWatching(scanned.dir)
    // No eager warm-up here. Generating renditions for every file made a large
    // folder take minutes before the wall felt usable, and most of those
    // thumbnails were never looked at. The renderer asks for what is on screen
    // instead, so work scales with what the user actually sees.
    return {
      dir: scanned.dir,
      photos: scanned.photos,
      skipped: scanned.skipped,
      durationMs: scanned.durationMs
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /**
   * Re-check the open folder in the background, and report only a real change.
   *
   * The wall is already showing this folder, so silence is the common and
   * correct outcome: nothing re-renders, nothing re-anchors, the view stays
   * exactly where the user left it. A difference is pushed as the full array
   * (`photos/delta` replaces rather than merges), which is the same shape the
   * watcher uses after a burst of events.
   */
  private async revalidate(): Promise<void> {
    const dir = this.dir
    const recursive = this.recursive
    const generation = this.generation
    const controller = new AbortController()
    this.revalidations.add(controller)
    try {
      const scanned = await scanDirectory(dir, {
        cache: this.metadataCache,
        recursive,
        signal: controller.signal
      })
      // The user may have opened something else, or toggled recursion, while
      // this ran. Applying the result then would replace a newer wall.
      if (generation !== this.generation || this.dir !== dir) return
      if (samePhotos(this.photos, scanned.photos)) return
      this.photos = scanned.photos
      this.notify(IPC.photosChanged, { kind: 'delta', photos: this.photos })
    } catch {
      // A re-check is an optimisation over what the watcher already reported;
      // failing to run it must never surface as an error.
    } finally {
      this.revalidations.delete(controller)
    }
  }

  /**
   * Run `revalidate` and keep the promise, so `drain` can wait for it.
   *
   * Without this, "did the re-check change anything?" would only be answerable
   * with a timeout, which makes the test that guards against a pointless
   * replacement order-dependent.
   */
  private startRevalidate(): void {
    const job = this.revalidate()
    this.revalidationJobs.add(job)
    void job.finally(() => this.revalidationJobs.delete(job))
  }

  /**
   * Send the cached view of `dir` as one complete snapshot.
   *
   * Best effort and empty-safe: no cache, an empty folder or a query failure all
   * mean the wall simply waits for the scan.
   *
   * One message rather than chunks on purpose. The renderer's layout, its
   * zoom-out floor (a binary search that re-lays out the whole set) and its
   * re-anchoring all key off the photo array, so each extra delivery is a full
   * re-layout and a possible jump of the view — measured on a 20 000-photo
   * library as a visibly flickering wall, not a smooth fill-in.
   */
  private emitCachedSeed(
    announceAs: string,
    dir: string,
    recursive: boolean,
    generation: number,
    rows?: readonly CachedPhotoRow[]
  ): void {
    if (!this.metadataCache) return
    // The user may have opened another folder while the rows were being read.
    if (generation !== this.generation) return
    const photos = this.cachedPhotos(dir, recursive, rows)
    if (photos.length === 0) return
    this.notify(IPC.scanSeed, { dir: announceAs, photos })
  }

  /**
   * The photos of `dir` as the metadata cache remembers them.
   *
   * File-free: one indexed query, so the renderer can paint the folder it is
   * about to open instead of waiting for the scan. What comes back is *stale by
   * construction* — a photo may have been deleted or re-exported since — which
   * is why the caller treats it as a placeholder and the scan replaces it.
   *
   * Only rows from this folder (and, when `recursive`, below it) are returned:
   * the cache serves every library the user has ever opened.
   */
  cachedPhotos(dir: string, recursive: boolean, rows?: readonly CachedPhotoRow[]): Photo[] {
    return sortPhotos([...this.cachedPhotoStream(dir, recursive, rows)])
  }

  /** The same photos, in cache order, for callers that build them lazily. */
  private *cachedPhotoStream(
    dir: string,
    recursive: boolean,
    rows?: readonly CachedPhotoRow[]
  ): Generator<Photo> {
    if (!this.metadataCache) return
    const absolute = resolve(dir)

    for (const row of rows ?? this.metadataCache.list(absolute)) {
      const relative = relativePath(absolute, row.path)
      // A row for the folder itself or for a path outside it cannot describe a
      // photo in this library; the range query should make that impossible, so
      // this only guards against a hand-edited database.
      if (!relative || relative.startsWith('..')) continue
      if (!recursive && relative.includes(sep)) continue

      const date = resolvePhotoDate(row.takenAt, row.mtimeMs)
      yield {
        id: photoId(row.path),
        path: row.path,
        // `pic://` URLs and the caption use forward slashes, as a scan does.
        name: relative.split(sep).join('/'),
        width: row.width,
        height: row.height,
        takenAt: date.takenAt,
        dateSource: date.dateSource,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes
      }
    }
  }

  /**
   * Wait for queued thumbnail work to finish.
   *
   * Thumbnail generation runs in the background so the wall can appear
   * immediately. Callers that are about to tear down state (closing the window,
   * switching libraries, or a test cleaning its temp directory) need to know
   * when that work has actually stopped touching the filesystem.
   */
  async drain(): Promise<void> {
    await this.thumbQueue.catch(() => undefined)
    // Re-checks started by a same-folder re-open also read the disk, so a test
    // that tears its temporary directory down has to wait for them too.
    while (this.revalidationJobs.size > 0) {
      await Promise.allSettled([...this.revalidationJobs])
    }
  }

  /**
   * `fs.watch` reports creation and deletion identically, so a `touch` event is
   * resolved by probing the filesystem at flush time.
   *
   * The result distinguishes added/changed photos from removals: a batch that
   * only deletes files yields no photos but still has to reach the renderer, or
   * the wall keeps showing thumbnails for files that are gone.
   */
  private async resolveEvents(events: readonly RawWatchEvent[]): Promise<{ touched: Photo[]; removed: boolean }> {
    const touched: Photo[] = []
    let removed = false

    for (const event of events) {
      if (event.type === 'change') {
        const refreshed = await this.refresh(event.path)
        if (refreshed) touched.push(refreshed)
        continue
      }

      // 'touch' — could be either direction.
      try {
        const info = await stat(event.path)
        if (!info.isFile()) continue
        const refreshed = await this.refresh(event.path)
        if (refreshed) touched.push(refreshed)
      } catch {
        if (findPhoto(this.photos, event.path)) {
          this.photos = removePhoto(this.photos, event.path)
          removed = true
        }
      }
    }

    if (removed) this.photos = sortPhotos(this.photos)
    return { touched, removed }
  }

  /** Re-read one file's metadata and fold it into the collection. */
  private async refresh(path: string): Promise<Photo | null> {
    try {
      const [info, meta] = await Promise.all([stat(path), readImageMetadata(path)])
      // A changed file has a new mtime/size, so any existing row no longer
      // matches. Writing the fresh parse keeps the cache useful after a
      // re-export: without it, the next launch would re-read the 512 KB prefix
      // for a photo that had just been parsed here.
      this.metadataCache?.store(path, info.mtimeMs, info.size, meta)
      // Same fallback the scan uses: a file re-exported without EXIF must not
      // lose its date and jump to the undated pile mid-session.
      const date = resolvePhotoDate(meta.takenAt, info.mtimeMs)
      const photo: Photo = {
        id: path.toLowerCase(),
        path,
        // Relative to the library root, so a recursive scan keeps the subfolder
        // in the name and two same-named photos stay distinguishable.
        name: relativeTo(this.dir, path),
        width: meta.width,
        height: meta.height,
        takenAt: date.takenAt,
        dateSource: date.dateSource,
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size
      }
      this.photos = upsertPhoto(this.photos, photo)
      return photo
    } catch {
      return null
    }
  }

  private startWatching(dir: string): DirectoryWatcher {
    // The generation this watcher belongs to. `fs.watch` delivers events
    // asynchronously and the handler below awaits `stat` plus an EXIF read, so a
    // batch can still be in flight when the user opens a different folder. Those
    // results used to be folded into the *new* library, splicing a file from the
    // previous folder into the wall that had just been opened.
    const generation = this.generation
    return watchDirectory(dir, {
      onEvents: (events) => {
        if (generation !== this.generation) return

        // The watcher is always recursive, so it sees subfolders whether or not
        // they are part of the library. Filtering here keeps the scan and the
        // watcher consistent: with the setting off, a new file in a subfolder
        // must not appear on the wall.
        const relevant = this.recursive
          ? events
          : events.filter((event) => !relativePath(dir, event.path).includes(sep))

        if (relevant.length === 0) return
        void this.resolveEvents(relevant).then(({ touched, removed }) => {
          // Re-check after the awaits: the user can open another folder while
          // the metadata is being read.
          if (generation !== this.generation) return
          // A deletion changes the wall without producing a photo to thumbnail.
          if (touched.length === 0 && !removed) return
          // New photos need thumbnails; changed ones need theirs rebuilt.
          if (touched.length > 0) this.warmThumbnails(touched, 'wall')
          this.notify(IPC.photosChanged, { kind: 'delta', photos: this.photos })
        })
      },
      onError: (error) => {
        if (generation !== this.generation) return
        // A failed watch is dead, not degraded: it will not deliver another
        // event. Clearing it is what turns the next re-open of this folder into
        // a real scan — without that, re-opening a folder whose watch had failed
        // would keep answering from a list that can no longer be kept current.
        this.watcher?.close()
        this.watcher = null
        this.notify(IPC.photosChanged, { kind: 'error', message: error.message })
      }
    })
  }

  /**
   * Generate thumbnails in the background, reporting progress.
   *
   * Only meaningful for the cached levels; `full` is the original file and has
   * nothing to generate.
   */
  warmThumbnails(photos: readonly Photo[], level: ThumbLevel): void {
    if (level === 'full') return
    const requests = photos.map((photo) => toThumbRequest(photo, level))
    this.thumbQueue = this.thumbQueue.then(() =>
      ensureThumbnails(this.thumbCacheDir, requests, {
        onDone: (done, total) => this.notify(IPC.thumbProgress, { done, total }),
        onWritten: this.onThumbWritten
      })
    )
  }

  /**
   * Resolve the URL for one photo at one level.
   *
   * `full` bypasses the cache entirely and streams the original, which is what
   * keeps the wall sharp at high zoom.
   *
   * `maxEdge` asks for a display-sized rendition instead of the level's fixed
   * size. The viewer uses it so the bitmap it receives matches the pixels it
   * will actually paint: a larger bitmap is downscaled again by Chromium, and
   * that second resample is the softness that made the viewer look worse than
   * the system viewer even though it was showing the full original.
   */
  async thumbUrlFor(
    photo: Photo,
    level: ThumbLevel,
    priority: ThumbPriority = 'interactive',
    maxEdge?: number
  ): Promise<string> {
    if (level === 'full') return photoUrl(relativeTo(this.dir, photo.path))
    const file = await ensureThumbnail(
      this.thumbCacheDir,
      toThumbRequest(photo, level, maxEdge),
      priority,
      this.onThumbWritten
    )
    // Relative, not `basename`: the cache is sharded into `a/b/` subdirectories,
    // and the `pic://thumb` handler resolves the path against the cache root.
    return thumbUrl(relativeTo(this.thumbCacheDir, file))
  }
}

/**
 * Whether two scans produced the same library.
 *
 * Compares what the wall and the cache actually depend on, and nothing else:
 * `mtimeMs` + `sizeBytes` are the cache's identity for a file, and the rest is
 * what a tile and its sort order are built from. Both arrays come from
 * `scanDirectory`, so they are already in the same order.
 */
function samePhotos(a: readonly Photo[], b: readonly Photo[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id ||
      left.mtimeMs !== right.mtimeMs ||
      left.sizeBytes !== right.sizeBytes ||
      left.takenAt !== right.takenAt ||
      left.width !== right.width ||
      left.height !== right.height
    ) {
      return false
    }
  }
  return true
}

function toThumbRequest(
  photo: Photo,
  level: Exclude<ThumbLevel, 'full'>,
  maxEdge?: number
): ThumbRequest {
  return {
    sourcePath: photo.path,
    mtimeMs: photo.mtimeMs,
    sizeBytes: photo.sizeBytes,
    level,
    maxEdge,
    // From the scan, so no extra read is needed to decide whether a `zoom`
    // rendition of this photo would hold more detail than `wall`.
    sourceWidth: photo.width,
    sourceHeight: photo.height
  }
}

/**
 * Path of `target` relative to `root`, with forward slashes.
 *
 * `pic://` URLs carry a path, not just a file name, so the protocol can serve
 * photos in subfolders of a recursively scanned library. Forward slashes are
 * used because that is what a URL path expects; `resolve()` on the other side
 * normalises them back.
 *
 * Falls back to the bare file name when `target` is not under `root`, which can
 * only happen for a stale watcher event.
 */
export function relativeTo(root: string, target: string): string {
  const relative = relativePath(root, target)
  if (!relative || relative.startsWith('..')) return basename(target)
  return relative.split(sep).join('/')
}

export interface IpcDeps {
  library: PhotoLibrary
  dataDir: string
  /** Disk bookkeeping for the thumbnail cache. */
  cache: ThumbCache
  appVersion: string
  /** Electron and Chromium versions, for the About dialog. */
  versions: { electron: string; chromium: string }
  /** Locale tags the OS prefers, most preferred first. */
  systemLocales: string[]
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      version: deps.appVersion,
      dataDir: deps.dataDir,
      thumbCacheDir: deps.library.thumbCacheDir,
      systemLocales: deps.systemLocales,
      electron: deps.versions.electron,
      chromium: deps.versions.chromium
    })
  )

  // The renderer owns language resolution, so it passes the active locale along.
  // Unknown tags are harmless: `registerIpc` falls back to English.
  ipcMain.handle(IPC.pickDirectory, async (_event, locale?: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: locales.translator(locale ?? '').t('dialog.chooseFolder'),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.openDirectory, (_event, dir: string, recursive?: boolean) =>
    deps.library.open(dir, { recursive })
  )

  /**
   * Open whatever was dropped on the window or handed over by "Open with".
   *
   * Dropping a folder opens it. Dropping a photo — or opening the app from
   * Explorer's context menu with a file selected — opens the folder that photo
   * lives in *and* reports which photo to focus, so the wall lands on the photo
   * the user pointed at rather than on the newest one in the folder.
   *
   * The path is resolved and type-checked in the main process: the renderer must
   * not be trusted to decide what a path is.
   */
  ipcMain.handle(
    IPC.openDropped,
    async (_event, target: string, recursive?: boolean): Promise<OpenDroppedResult> => {
      // Claim before resolving: `resolveOpenTarget` does a `stat`, which can be
      // slow on a sleeping drive. Claiming afterwards would order the opens by
      // when their `stat` finished rather than by when the user dropped them,
      // so dropping A then B could leave A on screen.
      const { generation, signal } = deps.library.claim()
      const resolved = await resolveOpenTarget(target)
      // `announceAs`: the renderer's state is keyed by the string it dropped, so
      // the cached snapshot has to be announced under that same string.
      const result = await deps.library.open(resolved.dir, {
        recursive,
        generation,
        signal,
        announceAs: target
      })
      return { ...result, photo: resolved.photo }
    }
  )

  ipcMain.handle(IPC.settingsLoad, () => loadSettings(deps.dataDir))
  ipcMain.handle(IPC.settingsSave, async (_event, settings: Settings) => {
    const saved = await saveSettings(deps.dataDir, settings)
    // A lowered limit takes effect now rather than at the next launch: the user
    // just said the cache may use less disk, and `setBudget` sweeps when the
    // current usage is already over what they asked for.
    deps.cache.setBudget(saved.cacheBudgetMb * 1024 * 1024)
    return saved
  })
  // Read by the settings menu. Cheap: the walk happens on a background timer,
  // so this only hands back the last known total.
  ipcMain.handle(IPC.cacheStats, (): CacheStats => deps.cache.stats())
  ipcMain.handle(IPC.thumbUrl, (_event, photo: Photo, level: ThumbLevel, maxEdge?: number) =>
    deps.library.thumbUrlFor(photo, level, 'interactive', maxEdge)
  )

  // Resolve a batch of renditions, streaming each result back as it finishes.
  //
  // Waiting for the whole batch meant the first visible tiles were blocked
  // behind every other tile in the request. Pushing each one immediately lets
  // the wall fill in progressively. The level travels with the result so a slow
  // low-quality encode cannot overwrite a sharper one that already arrived.
  //
  // `priority` separates speculative work (scroll prefetching) from tiles that
  // are on screen right now. Without it a prefetch sits at the head of the
  // encode queue and the visible tiles wait behind photos the user is not even
  // looking at yet.
  ipcMain.handle(
    IPC.thumbUrls,
    async (event, photos: Photo[], level: ThumbLevel, priority: ThumbPriority = 'interactive'): Promise<void> => {
      const sender = event.sender
      await Promise.all(
        photos.map(async (photo) => {
          try {
            const url = await deps.library.thumbUrlFor(photo, level, priority)
            if (!sender.isDestroyed()) sender.send(IPC.thumbReady, [photo.id, url, level] as [string, string, ThumbLevel])
          } catch {
            // A single unreadable photo must not fail the whole batch; the tile
            // simply stays on its placeholder.
          }
        })
      )
    }
  )
  ipcMain.handle(IPC.revealInFolder, (_event, path: string) => shell.showItemInFolder(path))

  // Window controls for the custom title bar. Each one resolves the sender's
  // window rather than trusting a window id from the renderer.
  const windowOf = (event: { sender: Electron.WebContents }): Electron.BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.windowMinimize, (event) => {
    windowOf(event)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (event): boolean => {
    const window = windowOf(event)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle(IPC.windowClose, (event) => {
    windowOf(event)?.close()
  })

  ipcMain.handle(IPC.windowState, (event): boolean => windowOf(event)?.isMaximized() ?? false)

  /**
   * Enter or leave OS fullscreen.
   *
   * Returns the resulting state rather than nothing: the renderer restores the
   * previous mode on exit, and a failed or ignored request has to be visible to
   * it, or the window would stay fullscreen after the show closes.
   */
  ipcMain.handle(IPC.windowFullScreen, (event, on: boolean): boolean => {
    const window = windowOf(event)
    if (!window) return false
    window.setFullScreen(on === true)
    return window.isFullScreen()
  })

  ipcMain.handle(IPC.windowIsFullScreen, (event): boolean => windowOf(event)?.isFullScreen() ?? false)

  /**
   * Full EXIF for one photo.
   *
   * The renderer supplies a path, so the request is untrusted: only photos the
   * library already knows about are readable. That reuses the same boundary as
   * `pic://` rather than inventing a second one, and stops a compromised
   * renderer from reading arbitrary files on disk.
   *
   * The first open of a photo parses the file and writes the result back, so
   * every later open — including after a restart — is a cache hit. That keeps
   * the scan from paying for fields nobody has looked at while still making the
   * common case (re-opening a photo you already inspected) instant.
   */
  ipcMain.handle(IPC.photoExif, async (_event, path: unknown): Promise<RawExif> => {
    if (typeof path !== 'string') return {}
    const photo = findPhoto(deps.library.all, path)
    if (!photo) return {}

    const cached = deps.library.metadataCache?.lookupExif(photo.path, photo.mtimeMs, photo.sizeBytes)
    if (cached) return cached

    const exif = await readFullExif(photo.path)
    deps.library.metadataCache?.storeExif(photo.path, photo.mtimeMs, photo.sizeBytes, exif)
    return exif
  })
}
