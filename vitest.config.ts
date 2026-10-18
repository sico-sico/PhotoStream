import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Test configuration.
 *
 * The app spans process boundaries, so two environments are needed: `node` for
 * main-process modules (metadata, scanning, settings) and `jsdom` for React
 * components and hooks. Each DOM test file opts in with a
 * `@vitest-environment jsdom` docblock, which keeps the choice visible next to
 * the tests that depend on it instead of hidden in a glob list.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage is measured on code that can actually regress. Type-only
      // modules, test helpers and the Electron bootstrap are excluded.
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/renderer/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/main/index.ts',
        'src/renderer/main.tsx',
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/renderer/i18n/context.ts',
        // `App` is pure composition: it wires hooks to components and holds no
        // logic of its own. Every branch worth asserting lives in a tested
        // module below it, and the integration path is covered by Playwright.
        // Unit-testing it would assert React's own rendering rather than our
        // behaviour.
        'src/renderer/App.tsx'
      ],
      // A floor rather than a target: it catches a feature landing with no
      // tests at all, without making every refactor fight the number.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70
      }
    }
  }
})
