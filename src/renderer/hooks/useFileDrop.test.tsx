// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileDrop } from './useFileDrop'

/**
 * Build a drag event with the `DataTransfer` shape the hook reads.
 *
 * jsdom implements neither `DataTransfer` nor a real drag pipeline, so the two
 * fields the hook actually touches (`types`, `files`, `dropEffect`) are faked.
 * That keeps the test about the hook's logic rather than about jsdom gaps.
 */
function dragEvent(type: string, options: { types?: string[]; files?: File[] } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const files = options.files ?? []
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: options.types ?? (files.length > 0 ? ['Files'] : []),
      files,
      dropEffect: 'none'
    }
  })
  return event
}

describe('useFileDrop', () => {
  it('starts not dragging', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))
    expect(result.current.dragging).toBe(false)
  })

  it('shows the overlay while files are over the window', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))

    act(() => {
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
    })
    expect(result.current.dragging).toBe(true)
  })

  it('ignores a drag that carries no files', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))

    act(() => {
      // Dragging selected text also fires dragenter; advertising "drop to open"
      // for it would be a lie.
      window.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }))
    })
    expect(result.current.dragging).toBe(false)
  })

  it('does not flicker while the pointer crosses child elements', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))

    act(() => {
      // Entering a child fires dragenter then dragleave on the parent.
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
      window.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }))
    })
    expect(result.current.dragging).toBe(true)

    act(() => {
      window.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }))
    })
    expect(result.current.dragging).toBe(false)
  })

  it('prevents the default so Chromium does not navigate to the file', () => {
    renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))

    const event = dragEvent('dragover', { types: ['Files'] })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('reports the path of the dropped file', () => {
    const onDrop = vi.fn()
    const file = new File(['x'], 'IMG.jpg')
    renderHook(() =>
      useFileDrop({ onDrop, pathForFile: () => 'C:\\photos\\IMG.jpg' })
    )

    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [file] }))
    })
    expect(onDrop).toHaveBeenCalledWith('C:\\photos\\IMG.jpg')
  })

  it('ignores a dropped file with no recoverable path', () => {
    const onDrop = vi.fn()
    renderHook(() => useFileDrop({ onDrop, pathForFile: () => '' }))

    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'synthetic.jpg')] }))
    })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('opens only the first of several dropped items', () => {
    const onDrop = vi.fn()
    renderHook(() => useFileDrop({ onDrop, pathForFile: (file) => `/x/${file.name}` }))

    act(() => {
      window.dispatchEvent(
        dragEvent('drop', { files: [new File(['x'], 'a'), new File(['x'], 'b')] })
      )
    })
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith('/x/a')
  })

  it('hides the overlay after a drop', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '/x' }))

    act(() => {
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
    })
    expect(result.current.dragging).toBe(true)

    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'a')] }))
    })
    expect(result.current.dragging).toBe(false)
  })

  it('clears the overlay when the drag is cancelled off-window', () => {
    const { result } = renderHook(() => useFileDrop({ onDrop: () => {}, pathForFile: () => '' }))

    act(() => {
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
    })
    expect(result.current.dragging).toBe(true)

    act(() => {
      // Leaving through the window edge can skip dragleave entirely; without
      // this the overlay would stay on screen forever.
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current.dragging).toBe(false)
  })

  it('detaches every listener when disabled', () => {
    const onDrop = vi.fn()
    renderHook(() => useFileDrop({ onDrop, pathForFile: () => '/x', enabled: false }))

    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'a')] }))
    })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('removes its window listeners on unmount', () => {
    const onDrop = vi.fn()
    const { unmount } = renderHook(() => useFileDrop({ onDrop, pathForFile: () => '/x' }))
    unmount()

    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'a')] }))
    })
    expect(onDrop).not.toHaveBeenCalled()
  })
})
