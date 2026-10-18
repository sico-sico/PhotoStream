/**
 * What a wheel event over the wall is asking for.
 *
 * The convention everywhere else is that a bare wheel scrolls, and a modified
 * wheel zooms: browsers, image viewers, CAD tools, maps. PhotoStream originally
 * zoomed on a bare wheel and never looked at `ctrlKey`, which meant the one
 * gesture every user tries first — scroll down — jumped the zoom instead of
 * moving through the library.
 *
 * Two modifiers count, for reasons of history rather than taste:
 * - `ctrlKey` is what Chrome and Firefox synthesise for a pinch gesture on a
 *   trackpad, so honouring it makes trackpad pinch work without a separate
 *   gesture recogniser;
 * - `metaKey` is the same key on macOS, where the convention is Cmd rather than
 *   Ctrl.
 *
 * Shift is not a zoom modifier: browsers translate it into horizontal scrolling,
 * and this returns `'pan'` for it so that translation still works.
 */
export type WheelIntent = 'zoom' | 'pan'

export interface WheelModifiers {
  ctrlKey: boolean
  metaKey: boolean
}

/** Decide whether a wheel event zooms or pans. */
export function wheelIntent(modifiers: WheelModifiers): WheelIntent {
  return modifiers.ctrlKey || modifiers.metaKey ? 'zoom' : 'pan'
}

/**
 * Screen-space pan for a wheel event, in CSS pixels.
 *
 * `deltaMode` differs between devices: mice report pixels, some drivers report
 * lines, and a few report pages. Normalising by the same units `zoomByWheel`
 * uses keeps the two gestures feeling consistent.
 *
 * `deltaX` is passed through rather than dropped: a trackpad's horizontal
 * component and Shift+wheel both arrive as a horizontal delta, and ignoring it
 * would make sideways movement impossible on devices without a second axis.
 */
export function wheelPan(deltaX: number, deltaY: number, deltaMode: number): { dx: number; dy: number } {
  const unit = deltaMode === 1 ? 33 : deltaMode === 2 ? 800 : 1
  // Negated: scrolling down moves the *content* up, which is a negative
  // translate. Matching the sign here keeps the caller free of the convention.
  return { dx: -deltaX * unit, dy: -deltaY * unit }
}
