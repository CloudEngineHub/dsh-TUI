#!/usr/bin/env node
/**
 * Regression: Ctrl/Option word editing in PromptInput (#156, #158, #1448).
 *
 * Windows Terminal (and most xterm-family terminals) deliver Ctrl+Left as
 * ESC[1;5D — parsed to { name: 'left', ctrl: true } (parse-keypress.ts) and
 * mapped to leftArrow:true with ctrl preserved (input-event.ts). The prompt
 * dispatch must therefore test isMod(key) && key.leftArrow BEFORE the bare
 * key.leftArrow arm, or the word-jump arms stay dead code and Ctrl+Arrow
 * degrades to single-char movement.
 *
 * End-to-end through the REAL tokenizer/parser/render pipeline (compiled
 * lib, mock channel): type "hello world", move the caret with Ctrl/bare
 * arrows, insert a distinct marker after each move, then submit — the final
 * string encodes every caret position (asserted at submit time):
 *   type  "hello world"                caret 11
 *   Ctrl+Left  → caret 6               insert X → "hello Xworld"   caret 7
 *   Ctrl+Left  → caret 6               insert Y → "hello YXworld"  caret 7
 *   bare Left  → caret 6  (single char — NOT a word jump to 0)
 *                                      insert Z → "hello ZYXworld" caret 7
 *   Ctrl+Right → caret 14 (end)        insert Q → "hello ZYXworldQ"
 *   Enter → channel.submit("hello ZYXworldQ")
 *
 * With the #156 bug (bare-arrow arm first) every Ctrl+Arrow moves a single
 * char and the markers land in different places, so the submitted value
 * differs. A word-jump-on-bare-arrow regression likewise moves marker Z.
 *
 * Option-as-Meta arrows, ESC b/f and all three Option+Backspace encodings
 * must reach the same whitespace-delimited editing path, including a text
 * and Option+Backspace pair delivered in one stdin batch.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-word-jump.mjs
 * Exits 1 on any failed assertion (CI gate).
 */
import { Writable, PassThrough } from 'node:stream'
// Redirect HOME/USERPROFILE into a throwaway sandbox before the app modules
// load: this fixture submits text, and `rememberHistory` persists it into
// `~/.dsh-tui/history.jsonl` — writing the developer's real input history from
// a test would both leak fixture strings into `↑`/Ctrl+R and (at the 200-entry
// cap) evict their real entries.
import './lib/fake-home.mjs'
import React from 'react'
import xterm from '@xterm/headless'
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const { render, AlternateScreen } = await import('../lib/types/ui.js')
const { PromptInput } = await import('../lib/types/components/PromptInput.js')
const columns = Number(process.env.DSH_TEST_COLUMNS ?? 100)
const fullscreen = process.env.DSH_TEST_FULLSCREEN === '1'
const terminal = new xterm.Terminal({ cols: columns, rows: 30, allowProposedApi: true })
const screen = () => viewportLines(terminal).join('\n')

function makeStreams() {
  const stdout = new Writable({ write(chunk, _e, cb) { terminal.write(String(chunk), cb) } })
  stdout.columns = columns
  stdout.rows = 30
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const submitted = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
  stageImage() {},
  listFiles: async () => [],
}

const { stdout, stderr, stdin } = makeStreams()
const prompt = React.createElement(PromptInput, {
  channel,
  helpOpen: false,
  onToggleHelp() {},
  onRunCommand: () => false,
  selectionActive: false,
})
const instance = await render(
  fullscreen ? React.createElement(AlternateScreen, null, prompt) : prompt,
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
await settle(() => screen().includes('❯'))

const feed = async seq => {
  stdin.write(seq)
  // 固定窗:pacing 按键步间——单次移动的语义用下一次插入后的提交值断言。
  await sleep(250)
}

await feed('hello world')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6 (word start; bug: 10)
await feed('X')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6
await feed('Y')
await feed('\x1b[D')    // bare Left  → caret 6 (single char; jump bug: 0)
await feed('Z')
await feed('\x1b[1;5C') // Ctrl+Right → caret 14 (end of "…world")
await feed('Q')
stdin.write('\r')

check(
  'caret moves + inserts compose to the expected submitted text',
  await settled(() => submitted.length === 1 && submitted[0] === 'hello ZYXworldQ'),
  JSON.stringify(submitted),
)

// Submit resets the draft. Each deletion case starts with a fresh line so
// accidentally dispatching Esc cannot be hidden by the previous case.
for (const seq of ['\x1b\x7f', '\x1b\b', '\x1b[127;3u']) {
  await settle(() => !screen().includes(submitted.at(-1)))
  await feed(`foo bar baz${seq}`)
  await feed(seq)
  await feed('Q')
  const before = submitted.length
  stdin.write('\r')
  check(`Option+Backspace ${JSON.stringify(seq)} deletes words without clearing the draft`,
    await settled(() => submitted.length === before + 1 && submitted.at(-1) === 'foo Q'),
    JSON.stringify(submitted.at(-1)))
}

await settle(() => !screen().includes(submitted.at(-1)))
for (const seq of ['aaa bbb ccc', '\x1b[1;3D', 'X', '\x1bb', 'Z', '\x1bf', 'Q', '\x1b[1;3D', '\x1b[1;3D', 'Y']) {
  await feed(seq)
}
check('Option arrows and ESC b/f share the word boundaries',
  await settled(() => screen().includes('aaa Ybbb ZXcccQ')), screen())
console.log(`SCREEN composer ${fullscreen ? 'fullscreen' : 'inline'} ${columns}x30\n${screen().trimEnd()}`)
const before = submitted.length
stdin.write('\r')
check('Option word jumps submit the expected unmodified text',
  await settled(() => submitted.length === before + 1 && submitted.at(-1) === 'aaa Ybbb ZXcccQ'),
  JSON.stringify(submitted.at(-1)))

instance.unmount()
terminal.dispose()

if (failed > 0) {
  console.error(`verify-word-jump: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-word-jump OK')
