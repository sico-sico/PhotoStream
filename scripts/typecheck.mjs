#!/usr/bin/env node
/**
 * Type-check every TS project, always running all of them.
 *
 * Chaining with `&&` (or PowerShell's `;`) hides the second failure behind the
 * first: a broken renderer would never be reported while main also had an
 * error. Running both and aggregating lets one pass show every problem.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const projects = ['tsconfig.node.json', 'tsconfig.web.json']

// Resolve the local tsc so the script does not depend on a global install.
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
let failed = false

for (const project of projects) {
  process.stdout.write(`\n> tsc --noEmit -p ${project}\n`)
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(root, project)], {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.status !== 0) failed = true
}

if (failed) {
  process.stderr.write('\ntypecheck failed\n')
  process.exit(1)
}
process.stdout.write('\ntypecheck passed\n')
