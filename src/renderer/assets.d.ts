/**
 * Ambient declarations for non-code imports.
 *
 * TypeScript 7 stopped inferring these: a bare `import './styles.css'` used to
 * resolve silently, and now reports TS2882. Declaring the modules explicitly is
 * the portable fix and works on both 5.x and 7.x.
 */

declare module '*.css' {
  const content: string
  export default content
}

declare module '*.svg' {
  const content: string
  export default content
}

declare module '*.png' {
  const content: string
  export default content
}
