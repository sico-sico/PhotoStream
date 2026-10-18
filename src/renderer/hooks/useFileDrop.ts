import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseFileDropOptions {
  /** Called with the dropped path once a drop completes. */
  onDrop: (path: string) => void
  /** Recover a real filesystem path from a dropped `File`. */
  pathForFile: (file: File) => string
  /** Disable the handler entirely (e.g. while a scan is already running). */
  enabled?: boolean
}

export interface UseFileDrop {
  /** True while a drag carrying files is over the window. */
  dragging: boolean
}

/**
 * Whole-window "drop a folder here" support.
 *
 * Three details make this behave rather than merely fire:
 *
 * 1. `dragenter`/`dragleave` fire for every child element the pointer crosses,
 *    so a naive counter flickers. A depth counter is used instead, and it is
 *    resynchronised on `drop` and on `dragend` so a missed `dragleave` (which
 *    happens when the drag leaves through a window edge) cannot leave the
 *    overlay stuck on screen.
 * 2. The default action has to be prevented on `dragover`, otherwise Chromium
 *    navigates to the dropped file and the app disappears.
 * 3. Only `dataTransfer.types` containing `Files` counts. Dragging selected text
 *    over the window also fires `dragenter`, and showing a "drop to open" hint
 *    for text would be a lie.
 *
 * Listening on `window` rather than a specific element means the whole window is
 * a target, which is what "drop a folder on the app" implies.
 */
export function useFileDrop({ onDrop, pathForFile, enabled = true }: UseFileDropOptions): UseFileDrop {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  useEffect(() => {
    if (!enabled) {
      reset()
      return
    }

    const carriesFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      // Required: without it the drop event never fires and Chromium opens the
      // file in the window instead.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }

    const onDropEvent = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      reset()

      const files = Array.from(event.dataTransfer?.files ?? [])
      // Several folders dropped at once has no single sensible answer, so the
      // first one wins; a multi-select is not what this gesture is for.
      for (const file of files) {
        const path = pathForFile(file)
        if (path) {
          onDrop(path)
          return
        }
      }
    }

    // `dragend` fires on the source element if the drag is cancelled, but not
    // when it leaves the OS window; `blur` on the window covers that case too.
    const onDragEnd = (): void => reset()

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDropEvent)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('blur', onDragEnd)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDropEvent)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('blur', onDragEnd)
    }
  }, [enabled, onDrop, pathForFile, reset])

  return { dragging }
}
