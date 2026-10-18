import { useCallback, useEffect, useId, useRef, useState } from 'react'

export interface MenuProps {
  /** Accessible label for the trigger button. */
  label: string
  /** Rendered inside the trigger; usually an icon. */
  icon: React.ReactNode
  /** Panel contents. Closing is the caller's job, via the passed callback. */
  children: (close: () => void) => React.ReactNode
  /** Extra class for the trigger, e.g. to mark it active. */
  triggerClass?: string
}

/**
 * A small dropdown panel anchored to its trigger.
 *
 * Written by hand rather than pulled from a library: the app needs exactly one
 * menu, the accessibility contract is a dozen lines, and a menu library would
 * add a dependency for a button and a positioned div.
 *
 * Behaviour that a native menu gives for free and is therefore implemented here:
 * - Escape closes and returns focus to the trigger;
 * - a click anywhere outside closes it;
 * - the panel is a `dialog`-less popup with `aria-expanded` on the trigger, so
 *   screen readers announce the state change.
 */
export function Menu({ label, icon, children, triggerClass = '' }: MenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelId = useId()

  const close = useCallback(() => {
    setOpen(false)
    // Focus goes back to the trigger, otherwise it is lost to the document body
    // and the next Tab press restarts from the top of the page.
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Swallow the Escape: the toolbar sits above the photo wall, and letting
      // it through would also clear the wall selection behind the menu.
      event.stopPropagation()
      close()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [close, open])

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`button ghost menu-trigger ${triggerClass}`}
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </button>

      {open ? (
        <div className="menu-panel" id={panelId} role="group" aria-label={label}>
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}
