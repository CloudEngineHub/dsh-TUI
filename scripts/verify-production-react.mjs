#!/usr/bin/env node
/** #685: isolated package-entry and launcher boots must select the actual
 * production React/reconciler builds unless the developer explicitly opts in.
 * Run: node scripts/verify-production-react.mjs (tsx and root deps required). */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-react-mode-'))
const probe = join(home, 'probe.mjs')
const envFile = join(home, '.env')
writeFileSync(envFile, 'NODE_ENV=development\n')
writeFileSync(probe, `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(process.env.REACT_PROBE_PACKAGE)
const check = () => {
  const expected = process.env.REACT_PROBE_EXPECTED
  assert.equal(process.env.NODE_ENV, expected)
  require('react')
  require('react-reconciler')
  for (const name of ['react', 'react-reconciler']) {
    const cached = Object.keys(require.cache)
    assert(cached.some(file => file.endsWith('/' + name + '.' + expected + '.js') || file.endsWith('\\\\' + name + '.' + expected + '.js')), name + ' selected the wrong build')
    const other = expected === 'production' ? 'development' : 'production'
    assert(!cached.some(file => file.endsWith('/' + name + '.' + other + '.js') || file.endsWith('\\\\' + name + '.' + other + '.js')), name + ' loaded both builds')
  }
  console.log('react-mode-ok')
}
if (process.env.REACT_PROBE_LAUNCHER === '1') {
  process.once('exit', check)
} else {
  if (process.env.REACT_PROBE_ENV_FILE) process.loadEnvFile(process.env.REACT_PROBE_ENV_FILE)
  await import(process.env.REACT_PROBE_ENTRY)
  check()
}
`)

const cases = [
  { name: 'unset' },
  { name: 'inherited development', nodeEnv: 'development' },
  { name: 'inherited production', nodeEnv: 'production' },
  { name: 'empty NODE_ENV', nodeEnv: '' },
  { name: 'disabled opt-in', nodeEnv: 'development', dev: '0' },
  { name: 'non-literal opt-in', nodeEnv: 'development', dev: 'true' },
  { name: 'explicit development', dev: '1' },
  { name: 'development overrides inherited production', nodeEnv: 'production', dev: '1' },
]
let passed = 0
try {
  for (const launcher of [false, true]) {
    for (const scenario of [...cases, ...(launcher ? [] : [{ name: 'workspace .env', envFile }])]) {
      const result = spawnSync(process.execPath, launcher
        ? ['--import', pathToFileURL(probe).href, join(root, 'bin/dsh-tui.js'), 'help']
        : ['--import', 'tsx/esm', probe], {
        cwd: root,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, 'dsh'),
          NODE_ENV: scenario.nodeEnv, DSH_TUI_REACT_DEV: scenario.dev,
          REACT_PROBE_PACKAGE: join(root, 'package.json'),
          REACT_PROBE_ENTRY: new URL('../src/index.ts', import.meta.url).href,
          REACT_PROBE_EXPECTED: scenario.dev === '1' ? 'development' : 'production',
          REACT_PROBE_LAUNCHER: launcher ? '1' : '0',
          REACT_PROBE_ENV_FILE: scenario.envFile,
        },
        encoding: 'utf8', timeout: 15_000,
      })
      const label = `${launcher ? 'launcher' : 'package entry'}: ${scenario.name}`
      assert.equal(result.status, 0, `${label}\n${result.error ?? ''}\n${result.stderr}`)
      assert(result.stdout.includes('react-mode-ok'), label)
      passed += 1
      console.log('PASS ' + label)
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`verify-production-react OK (${passed} isolated boots)`)
