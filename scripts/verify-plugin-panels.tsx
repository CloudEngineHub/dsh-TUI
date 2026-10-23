/**
 * Plugin side-panel regression (ctx.tuiPanels, §18 Phase 6): full-chain
 * admission on a real Cordis composition, plus a render smoke proving a
 * crashing plugin panel is isolated (error card, then session disable)
 * while the chat side keeps rendering.
 *
 * Store-level chain (mirrors verify-plugin-lifecycle):
 *  - root-context register/list rejected (requirePluginCaller);
 *  - register → PanelStore entry with '<pluginId>:' prefixed id,
 *    source='plugin', mountPolicy forced 'active', minColumns default 28,
 *    and the stored `sidePanel.panels` value left untouched (registration
 *    never rewrites the setting; `*` derives the enabled set from the
 *    registry instead);
 *  - duplicate id → undefined + ledger DUPLICATE_CONTRIBUTION_ID;
 *  - per-plugin budget (≤4) → undefined + ledger PANEL_BUDGET_EXCEEDED;
 *  - descriptor validation: apiVersion/id/title/icon-width/component-or-
 *    compact/maxRows;
 *  - badge/list/open/close ownership: foreign ids rejected;
 *  - open rate limit: second open within 5s dropped + ledger RATE_LIMITED
 *    (no-consumer open returns false without rate-limit consumption);
 *  - subscribe: only own-panel events (registered/badge/unregistered/
 *    disabled), listener errors swallowed;
 *  - dispose → store entry gone, effective set no longer enables it, ledger
 *    release recorded.
 *
 * Render smoke (headless XTerm): throwing plugin panel renders the error
 * card and the chat body stays intact; the 3rd reportError flips the entry
 * to the session-disabled card and fires one channel.notify toast.
 *
 * Kit surface (headless XTerm): ui.Markdown / ui.CodeBlock render inside a
 * panel-narrowed TerminalSizeContext — 28/38 columns plus a resize to 60,
 * fence length outgrows inner ``` runs, the language label sheds backticks
 * and spaces, ui.CodeBlock keeps prompt-analysis tag blocks (raw code), and
 * the code body picks up cli-highlight's colours once it loads.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-panels.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ReactNode } from 'react'
import type { TuiPanelProps } from '../src/panels.js'

const [cordis, React, XTermMod, ui, termTest, prefs, i18nMod, adapterMod, storeMod, bridgeMod, panelAdapterMod] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/panels.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/components/sidePanel/panelBridge.js'),
  import('../src/components/sidePanel/pluginPanelAdapter.js'),
])
const { Context } = cordis
const { Terminal: XTerm } = XTermMod
const { render, ThemeProvider, AlternateScreen, Box, Text } = ui
const { settled, sleep } = termTest
const { applyCodeFrameStyle, applySidePanelPanels, getHiddenTemporarySidePanels, getSidePanelPanels, resolveSidePanelIds, setTemporarySidePanelHidden } = prefs
const { setLang } = i18nMod
const { TuiPanelRuntime, getHostPanelRuntime } = adapterMod
const { panelStore } = storeMod
const { panelBridgeRequests } = bridgeMod
void panelAdapterMod

const { TuiEffectLedgerRuntime } = await import('../src/dsh-adapter/effect-ledger.js')
const { PanelHost } = await import('../src/components/sidePanel/PanelHost.js')

setLang('zh')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

const ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-tui-panels-'))
const ledgerFile = join(ledgerDir, 'ledger.jsonl')

const root = new Context()
await root.plugin(TuiEffectLedgerRuntime, { file: ledgerFile })
await root.plugin(TuiPanelRuntime)
const svc = root.get('tuiPanels') as InstanceType<typeof TuiPanelRuntime>
check('service mounted + host facade', svc !== undefined && getHostPanelRuntime(svc) !== undefined)

type PanelsService = InstanceType<typeof TuiPanelRuntime>
const rootSvc = root.get('tuiPanels') as PanelsService

// Root-context mutation must be rejected (requirePluginCaller).
let rootRegisterRejected = false
try { rootSvc.register({ apiVersion: 1, id: 'root-leak', title: 'root', component: () => null }) } catch { rootRegisterRejected = true }
check('root register rejected', rootRegisterRejected === true || rootSvc.register({ apiVersion: 1, id: 'root-leak', title: 'root', component: () => null }) === undefined)
let rootListRejected = false
try { rootSvc.list() } catch { rootListRejected = true }
check('root list rejected', rootListRejected)

// Two live plugin activations.
let pluginA: Context | undefined
let pluginB: Context | undefined
root.inject(['tuiPanels'], ctx => { pluginA = ctx })
root.inject(['tuiPanels'], ctx => { pluginB = ctx })
await new Promise(resolve => setImmediate(resolve))
if (pluginA === undefined || pluginB === undefined) throw new Error('could not create plugin activations')
// Keep the persistent-selection cases on a verified Component. Anonymous
// activations below exercise the separate session-only selection path.
const { bindComponentIdentity } = await import('../src/dsh-adapter/component-identity.js')
const { parseManifest, projectManifest } = await import('../src/adapter/standard/protocols.js')
const { testManifest } = await import('./lib/plugin-test-utils.js')
const manifestA = parseManifest(testManifest({ id: 'verify-panel-a' }), { source: 'test:panels' })
bindComponentIdentity(pluginA, manifestA, projectManifest(manifestA), 'verify-panel-a-activation')
const panelsA = pluginA.get('tuiPanels') as PanelsService
const panelsB = pluginB.get('tuiPanels') as PanelsService

function ledgerRecords(): { operation?: string; resource?: { kind?: string; id?: string }; result?: string; errorCode?: string }[] {
  try {
    return readFileSync(ledgerFile, 'utf8').split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>) as never
  } catch {
    return []
  }
}

// ── register full chain ───────────────────────────────────────────────────
applySidePanelPanels('todo')
const disposeA = panelsA.register({ apiVersion: 1, id: 'metrics', title: 'Metrics', icon: '◉', component: () => null })
check('register returns disposer', typeof disposeA === 'function')
const entryA = panelStore.list().find(e => e.definition.id.endsWith(':metrics'))
check('store entry with plugin: prefix id', entryA !== undefined && /^[a-z0-9_-]+:metrics$/u.test(entryA.definition.id))
check('source/mountPolicy/minColumns forced', entryA !== undefined
  && entryA.definition.source === 'plugin'
  && entryA.definition.mountPolicy === 'active'
  && entryA.definition.minColumns === 28)
check('registration leaves the stored value untouched', getSidePanelPanels() === 'todo')
check('own list() summary', panelsA.list().some(p => p.id === entryA!.definition.id)
  && !panelsA.list().some(p => (p as { title?: string }).title === undefined))
check('ledger bind applied', ledgerRecords().some(r => r.resource?.kind === 'panel' && r.resource?.id === entryA!.definition.id && r.result === 'applied'))

const registeredIds = (): string[] => panelStore.list().map(e => e.definition.id)
const effectiveIds = (): readonly string[] => resolveSidePanelIds(getSidePanelPanels(), registeredIds())
const pluginIdA = entryA!.definition.id

// ── `*` derives the enabled set from the registry (issue #1662 / #1454) ────
// Registration never writes the setting: under `*` (the default) the panel is
// enabled because it is registered, and nothing has to be merged back on the
// next apply.
applySidePanelPanels('*')
check('store keeps the raw * sentinel', getSidePanelPanels() === '*')
check('* enables the registered plugin panel', effectiveIds().includes(pluginIdA))
applySidePanelPanels('*')
check('re-applying * is idempotent', effectiveIds().includes(pluginIdA) && getSidePanelPanels() === '*')
// The contract's other half: an explicit list is exact, so a registered panel
// that is not listed is hidden (statusBar parity). No union, no inference.
applySidePanelPanels('todo,jobs')
check('an explicit list hides an unlisted registered panel', !effectiveIds().includes(pluginIdA))
check('the explicit list still enables its own ids', effectiveIds().includes('todo') && effectiveIds().includes('jobs'))
applySidePanelPanels('*')
check('back under *, the plugin panel returns', effectiveIds().includes(pluginIdA))

// ── an explicit removal is just a list; replaying it changes nothing ──────
const disposeRemoved = panelsA.register({ apiVersion: 1, id: 'removable', title: 'Removable', component: () => null })
const removedId = panelStore.list().find(e => e.definition.id.endsWith(':removable'))?.definition.id ?? ''
check('removal fixture registered', removedId !== '' && effectiveIds().includes(removedId))
const withoutRemoved = effectiveIds().filter(id => id !== removedId).join(',')
applySidePanelPanels(withoutRemoved)
check('an explicit list stays exact (the removed one is out)',
  !effectiveIds().includes(removedId) && effectiveIds().includes(pluginIdA))
applySidePanelPanels(withoutRemoved)
check('replaying the same settings value does not revive it', !effectiveIds().includes(removedId))
disposeRemoved()
check('plugin unregister removes it from the effective set', !effectiveIds().includes(removedId))
applySidePanelPanels('*')

// descriptor validation
check('apiVersion gate', panelsA.register({ apiVersion: 2 as never, id: 'v2', title: 'x', component: () => null }) === undefined)
check('bad id gate', panelsA.register({ apiVersion: 1, id: 'Bad Id', title: 'x', component: () => null }) === undefined)
check('empty title gate', panelsA.register({ apiVersion: 1, id: 't', title: '  ', component: () => null }) === undefined)
check('icon width gate', panelsA.register({ apiVersion: 1, id: 'ic', title: 'x', icon: '中文', component: () => null }) === undefined)
check('component-or-compact gate', panelsA.register({ apiVersion: 1, id: 'none', title: 'x' }) === undefined)
check('compact maxRows gate', panelsA.register({ apiVersion: 1, id: 'cz', title: 'x', compact: { maxRows: 4 as never, component: () => null } }) === undefined)
const disposeCompact = panelsA.register({ apiVersion: 1, id: 'compact-only', title: 'Compact', compact: { maxRows: 2, component: () => null } })
check('compact-only accepted (validated, not mounted)', typeof disposeCompact === 'function')

// duplicate + budget
check('duplicate id undefined', panelsA.register({ apiVersion: 1, id: 'metrics', title: 'Again', component: () => null }) === undefined)
check('duplicate ledger DUPLICATE_CONTRIBUTION_ID', ledgerRecords().some(r => r.errorCode === 'DUPLICATE_CONTRIBUTION_ID'))
check('per-plugin budget ≤4', (() => {
  for (let i = 0; i < 4; i += 1) {
    panelsA.register({ apiVersion: 1, id: 'extra' + i, title: 'E', component: () => null })?.()
  }
  // A now owns metrics + compact-only (2); two more fit, the third must fail.
  const ok1 = panelsA.register({ apiVersion: 1, id: 'p3', title: 'E', component: () => null }) !== undefined
  const ok2 = panelsA.register({ apiVersion: 1, id: 'p4', title: 'E', component: () => null }) !== undefined
  const bad = panelsA.register({ apiVersion: 1, id: 'p5', title: 'E', component: () => null }) === undefined
  return ok1 && ok2 && bad
})())
check('budget ledger PANEL_BUDGET_EXCEEDED', ledgerRecords().some(r => r.errorCode === 'PANEL_BUDGET_EXCEEDED'))
// cleanup extras so later counts stay deterministic
for (const id of [...panelsA.list().map(p => p.id)]) {
  if (!id.endsWith(':metrics')) {
    // find its disposer? register returned them above but we dropped some;
    // dropping via a fresh re-register is impossible — remove by store side.
  }
}
// (extras stay registered under A; that is fine for the remaining checks)

// ── ownership: B cannot touch A's panel ──────────────────────────────────
const idA = entryA!.definition.id
check('foreign badge rejected', panelsB.badge(idA, { level: 'info', unread: 1 }) === false)
check('foreign open rejected', panelsB.open(idA) === false)
check('foreign close rejected', panelsB.close(idA) === false)
check('unknown id open rejected', panelsA.open('nobody:home') === false)

// ── badge ────────────────────────────────────────────────────────────────
check('own badge applied', panelsA.badge(idA, { level: 'warning', unread: 3 }) === true && panelStore.get(idA)?.badge?.unread === 3)
check('own badge cleared', panelsA.badge(idA, null) === true && panelStore.get(idA)?.badge === null)
check('invalid badge rejected', panelsA.badge(idA, { level: 'nope' as never, unread: 1 }) === false)

// ── open rate limit + no-consumer semantics ─────────────────────────────
check('open without Chat consumer returns false', panelsA.open(idA) === false)
panelBridgeRequests.attach()
check('first open with consumer accepted', panelsA.open(idA) === true)
check('second open within 5s dropped', panelsA.open(idA) === false)
check('rate-limit ledger RATE_LIMITED', ledgerRecords().some(r => r.errorCode === 'RATE_LIMITED' && r.resource?.id === idA))
check('close routed with consumer', panelsA.close(idA) === true)
panelBridgeRequests.detach()

// ── subscribe: own events only ───────────────────────────────────────────
const eventsA: string[] = []
const disposeSub = panelsA.subscribe(event => {
  eventsA.push(event.type + ':' + event.id)
  if (event.type === 'badge') throw new Error('listener crash must be swallowed')
})
const disposeB = panelsB.register({ apiVersion: 1, id: 'bpanel', title: 'B', component: () => null })
const idB = panelsB.list().find(e => e.id.endsWith(':bpanel'))?.id ?? 'b:none'
check('anonymous id has a disjoint session namespace', /^session:act[0-9]+:bpanel$/u.test(idB))
// A stored value cannot name a temporary panel, so its membership follows the
// registry (a saved selection leaves it alone) and closing it is session
// state that no replay revives.
applySidePanelPanels('todo')
check('a saved selection keeps the anonymous panel enabled',
  resolveSidePanelIds(getSidePanelPanels(), [idB]).includes(idB))
check('the stored value itself never carries the temporary id', !getSidePanelPanels().includes('session:'))
setTemporarySidePanelHidden(idB, true)
applySidePanelPanels('todo,jobs')
check('a saved selection cannot revive a session-only panel closed this run',
  !resolveSidePanelIds(getSidePanelPanels(), [idB], getHiddenTemporarySidePanels()).includes(idB))
setTemporarySidePanelHidden(idB, false)
applySidePanelPanels('todo,component:' + idB)
check('no stored spelling can name the temporary panel', !resolveSidePanelIds(getSidePanelPanels(), []).includes(idB))
check('session-only panel comes back without a saved id',
  resolveSidePanelIds(getSidePanelPanels(), [idB]).includes(idB))
panelsA.badge(idA, { level: 'info', unread: 1 })
panelsB.badge(idB, { level: 'info', unread: 1 })
check('own badge event delivered + listener crash swallowed', eventsA.some(e => e === 'badge:' + idA))
check('foreign badge event filtered', !eventsA.some(e => e === 'badge:' + idB))
disposeCompact?.()
await new Promise(resolve => setImmediate(resolve))
check('own unregistered event delivered', eventsA.some(e => e.startsWith('unregistered:') && e.endsWith(':compact-only')))
const beforeForeign = eventsA.length
setTemporarySidePanelHidden(idB, true)
check('a hidden temporary panel leaves the effective set',
  !resolveSidePanelIds(getSidePanelPanels(), [idB], getHiddenTemporarySidePanels()).includes(idB))
disposeB()
await new Promise(resolve => setImmediate(resolve))
check('foreign unregistered event filtered', eventsA.slice(beforeForeign).every(e => !e.endsWith(':bpanel')))
disposeSub()
// Hiding belongs to ONE registration: the same activation re-registering the
// same panel reuses its session-only id, and a fresh contribution must not be
// born hidden by the previous one (main's "re-registration is a new
// contribution", carried over to the run-local set).
const disposeB2 = panelsB.register({ apiVersion: 1, id: 'bpanel', title: 'B', component: () => null })
const idB2 = panelsB.list().find(e => e.id.endsWith(':bpanel'))?.id ?? ''
check('re-registration is a new contribution, not the hidden one',
  idB2 === idB && resolveSidePanelIds(getSidePanelPanels(), [idB2], getHiddenTemporarySidePanels()).includes(idB2),
  idB2 + ' hidden=' + JSON.stringify(getHiddenTemporarySidePanels()))
disposeB2()
await new Promise(resolve => setImmediate(resolve))

// ── crash disable (store level) ──────────────────────────────────────────
panelStore.reportError(idA, new Error('crash-1'))
panelStore.reportError(idA, new Error('crash-2'))
panelStore.reportError(idA, new Error('crash-3'))
check('3 crashes disable the panel', panelStore.get(idA)?.disabled === true)

// ── dispose: store entry + effective set + ledger release ───────────────
disposeA?.()
check('dispose removes store entry', panelStore.get(idA) === undefined)
check('dispose removes it from the effective set', !effectiveIds().includes(idA))
check('dispose records ledger release', ledgerRecords().some(r => r.resource?.id === idA && r.result === 'applied' && r.operation === 'release'))

// ── render smoke: crash isolation + disabled card ───────────────────────
// fresh panel that throws on every render (boundary catches → error card)
const smokeComponent = (): null => { throw new Error('plugin boom') }
applySidePanelPanels('todo')
applySidePanelPanels(getSidePanelPanels())
let smokeDispose: (() => void) | undefined
let smokePanelId = ''
root.inject(['tuiPanels'], ctx => {
  smokeDispose = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'smoke', title: 'Smoke', icon: '◆', component: smokeComponent as never,
  })
})
await new Promise(resolve => setImmediate(resolve))
smokePanelId = panelStore.list().find(e => e.definition.id.endsWith(':smoke'))?.definition.id ?? ''
check('smoke panel registered', smokePanelId !== '')

const notifyCalls: string[] = []
const channelStub = {
  version: 0, rows: [], status: 'idle', working: false, sessionId: 's1', cwd: '/tmp',
  spinnerMode: 'idle', goal: undefined, todos: [], subagents: [], backgroundJobs: [],
  notify(text: string) { notifyCalls.push(text) },
  subscribe() { return () => {} },
}
const fakeController = {
  enabledPanelIds: [smokePanelId],
  activePanelId: smokePanelId,
  focus: 'panel' as const,
  zoom: false,
  runtime: { registerInput: () => () => {}, dispatchKey: () => false },
}

const ROWS = 16
const COLS = 60
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; override ref() { return this }; override unref() { return this } }

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const app = await render(
  <AlternateScreen>
    <ThemeProvider theme="dark">
      <Box>
        <Box flexDirection="column" width={20}><Text>chat-ok</Text></Box>
        <PanelHost
          controller={fakeController as never}
          channel={channelStub as never}
          width={38}
          height={12}
        />
      </Box>
    </ThemeProvider>
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
await settled(() => lines().some(l => l.includes('chat-ok')))
await sleep(60) // 固定窗:pacing 首帧错误卡渲染 flush
const frame1 = lines()
check('render smoke: chat unaffected', frame1.some(l => l.includes('chat-ok')))
check('render smoke: error card shown', frame1.some(l => l.includes('面板渲染出错')))
panelStore.reportError(smokePanelId, new Error('crash-2'))
panelStore.reportError(smokePanelId, new Error('crash-3'))
await settled(() => lines().some(l => l.includes('面板已禁用')))
check('render smoke: disabled card after 3 crashes', lines().some(l => l.includes('面板已禁用')))
check('render smoke: disable toast fired once', notifyCalls.filter(text => text.includes('禁用')).length === 1)
await app.unmount()
smokeDispose?.()

// ── kit surface: ui.Markdown / ui.CodeBlock（#1456）──────────────────────
// 单独起 app：不放 chat 列、行数够，外层终端比面板宽 40 列。上面那条 60×16
// 的 app 面板正文只有 12 行、且第 0–19 列是 chat 列——九特性夹具在那里必然
// 被裁。外层终端必须明显更宽：「误用外层宽度」只有在越过 CodeBlockFrame 的
// 56 列宽表头阈值之后才看得见（见 openPanelScreen 的注释）。
const { stringWidth } = await import('../src/ink/stringWidth.js')
const { fenced } = await import('../src/components/sidePanel/panelMarkdown.js')

// 固定成 light：只有 header + rail，没有右边墙与底边，形态断言才确定。
applyCodeFrameStyle('light')

const RICH_MARKDOWN = [
  '# 面板标题',
  '',
  '一段足够长的正文，用来验证它在面板宽度内折行，而不是溢出后被裁掉。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块',
  '',
  '- [x] 已完成的任务',
  '',
  '~~删除线~~ 与 [链接](https://example.com)',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
].join('\n')

/** 正文里含 ```：围栏必须比它长，否则后两行会跑到框外。 */
const TRICKY_CODE = 'const a = 1\n```\nconst b = 3'

function RichPanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { Markdown } = kit
  return <Markdown>{RICH_MARKDOWN}</Markdown>
}

function CodePanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { CodeBlock } = kit
  return <CodeBlock code={TRICKY_CODE} language="ts" />
}

/** `<context>` 是宿主对聊天正文剥离的 prompt 标签块；`ui.CodeBlock` 承诺
 *  「原始代码」，这三行必须原样到达屏幕（`ui.Markdown` 则保持聊天口径）。 */
const TAGGED_CODE = 'const before = 1\n<context>\nkept line\n</context>\nconst after = 2'

function TaggedPanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { CodeBlock } = kit
  return <CodeBlock code={TAGGED_CODE} language="ts" />
}

let richDispose: (() => void) | undefined
let codeDispose: (() => void) | undefined
let taggedDispose: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  const panels = ctx.get('tuiPanels') as PanelsService
  richDispose = panels.register({ apiVersion: 1, id: 'rich', title: 'Rich', component: RichPanel as never })
  codeDispose = panels.register({ apiVersion: 1, id: 'tricky', title: 'Tricky', component: CodePanel as never })
  taggedDispose = panels.register({ apiVersion: 1, id: 'tagged', title: 'Tagged', component: TaggedPanel as never })
})
await new Promise(resolve => setImmediate(resolve))
const panelIdBySuffix = (suffix: string): string =>
  panelStore.list().find(entry => entry.definition.id.endsWith(':' + suffix))?.definition.id ?? ''
const richPanelId = panelIdBySuffix('rich')
const codePanelId = panelIdBySuffix('tricky')
const taggedPanelId = panelIdBySuffix('tagged')
check('kit panels registered', richPanelId !== '' && codePanelId !== '' && taggedPanelId !== '')

/** 只挂 PanelHost 的一条 app：面板占左侧 width 列，外层终端更宽——于是
 *  「面板宽靠 TerminalSizeContext 收窄」才有可观测后果（终端宽 - 面板宽 >
 *  0 时，收窄一旦丢失，表格右边框就会落到裁剪线之外）。resize 用同一棵树
 *  走 Ink 的 rerender，证明宽度感知节点跟随面板宽度变化。 */
async function openPanelScreen(
  panelId: string,
  width: number,
  height: number,
): Promise<{
  lines: () => string[]
  cell: (x: number, y: number) => { isFgDefault(): boolean } | undefined
  resize: (nextWidth: number, nextHeight: number) => void
  close: () => Promise<void>
}> {
  // 外层要足够宽：误用外层宽度时 contentWidth（宽 - 4）必须越过 CodeBlockFrame
  // 的 56 列宽表头阈值，收窄丢失才有可见后果。
  const outerCols = (panelWidth: number): number => panelWidth + 40
  const xterm = new XTerm({ cols: outerCols(width), rows: height + 4, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(xterm)
  out.columns = xterm.cols
  out.rows = xterm.rows
  const controller = {
    enabledPanelIds: [panelId],
    activePanelId: panelId,
    focus: 'panel' as const,
    zoom: false,
    runtime: { registerInput: () => () => {}, dispatchKey: () => false },
  }
  const tree = (panelWidth: number, panelHeight: number): ReactNode => (
    <AlternateScreen>
      <ThemeProvider theme="dark">
        <Box width={panelWidth}>
          <PanelHost controller={controller as never} channel={channelStub as never} width={panelWidth} height={panelHeight} />
        </Box>
      </ThemeProvider>
    </AlternateScreen>
  )
  const rendered = await render(tree(width, height), {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const read = (): string[] => {
    const buf = xterm.buffer.active
    const lines: string[] = []
    for (let y = 0; y < xterm.rows; y += 1) lines.push((buf.getLine(y)?.translateToString(false) ?? '').trimEnd())
    return lines
  }
  return {
    lines: read,
    cell: (x, y) => xterm.buffer.active.getLine(y)?.getCell(x),
    resize: (nextWidth, nextHeight) => {
      xterm.resize(outerCols(nextWidth), nextHeight + 4)
      out.columns = xterm.cols
      out.rows = xterm.rows
      rendered.rerender(tree(nextWidth, nextHeight))
    },
    close: async () => { await rendered.unmount() },
  }
}

const wide = await openPanelScreen(richPanelId, 38, 32)
check(
  'markdown panel (38): renders heading/list/quote/strike/link',
  await settled(() => {
    const rows = wide.lines()
    return ['面板标题', '列表项一', '引用块', '删除线', 'example.com'].every(text => rows.some(line => line.includes(text)))
  }),
)
const wideLines = wide.lines()
const wideOverflow = wideLines.filter(line => stringWidth(line) > 38)
const wideTable = wideLines.find(line => line.includes('列A')) ?? ''
// 承重信号是「宽度感知节点按面板宽排版」，不是帧宽：
// - 代码框表头在 34 列内容宽下是窄形态（`┌─ ts`，无分隔线）；收窄一丢，
//   contentWidth 变 56，表头立刻带上分隔线。
// - 表格在 34 列预算下仍是有边框形态；收窄一丢，它按 56 排版并在 38 处折行，
//   表头那行不再以右边框收尾。
// 普通文本会被 Ink 按盒宽折行，帧宽永远不越界，所以宽断言本身证明不了收窄。
check(
  'markdown panel (38): width-aware nodes lay out against the panel width',
  wideOverflow.length === 0 && wideLines.includes('┌─ ts') && wideTable.endsWith('│'),
  wideOverflow[0] ?? (wideLines.find(line => line.startsWith('┌─')) ?? wideTable),
)
await wide.close()

const narrow = await openPanelScreen(richPanelId, 28, 32)
check('markdown panel (28): renders at the default minColumns', await settled(() => narrow.lines().some(line => line.includes('列A'))))
const narrowLines = narrow.lines()
const narrowOverflow = narrowLines.filter(line => stringWidth(line) > 28)
const narrowTable = narrowLines.find(line => line.includes('列A')) ?? ''
check(
  'markdown panel (28): width-aware nodes lay out against the panel width',
  narrowOverflow.length === 0 && narrowLines.includes('┌─ ts') && narrowTable.endsWith('│'),
  narrowOverflow[0] ?? (narrowLines.find(line => line.startsWith('┌─')) ?? narrowTable),
)
await narrow.close()

// 尺寸变化（#1456 验收）：同一棵树重渲染成 60 列，宽度感知节点必须换形态——
// 60 - 4 = 56 到达 CodeBlockFrame 的宽表头阈值，表头从 `┌─ ts` 变成带分隔线。
const resized = await openPanelScreen(richPanelId, 38, 32)
check('markdown panel: narrow form before resize', await settled(() => resized.lines().includes('┌─ ts')))
resized.resize(60, 32)
check(
  'markdown panel: resize re-lays width-aware nodes against the new width',
  await settled(() => resized.lines().some(line => line.startsWith('┌─ ts ─'))),
)
const resizedLines = resized.lines()
const resizedTable = resizedLines.find(line => line.includes('列A')) ?? ''
check(
  'markdown panel: resized frame and table fit the new width',
  resizedLines.filter(line => stringWidth(line) > 60).length === 0 && resizedTable.endsWith('│'),
  resizedLines.filter(line => stringWidth(line) > 60)[0] ?? resizedTable,
)
await resized.close()

const code = await openPanelScreen(codePanelId, 38, 16)
check('code block: body renders', await settled(() => code.lines().some(line => line.includes('const a = 1'))))
const codeLines = code.lines()
// 38 宽面板 → contentWidth 34 < 56，表头是窄形态（无分隔线）。出现分隔线
// 就说明 code frame 拿到了面板外的宽度。
check('code block: header stays in the panel-width form', codeLines.includes('┌─ ts'), codeLines.find(line => line.startsWith('┌─')) ?? '')
check(
  'code block: one frame holds all three rows (inner ``` did not close it)',
  codeLines.filter(line => line.startsWith('│ ')).length === 3,
  'rail rows=' + String(codeLines.filter(line => line.startsWith('│ ')).length),
)
check('code block: only one frame header (no stray re-opened fence)', codeLines.filter(line => line.startsWith('┌─ ')).length === 1)
// 高亮是异步加载的（文档第①条限制）：cli-highlight 就绪后，代码体里必须出现
// 非默认前景色。轨道（x=0）自带主题色，所以从 x=2（body 首列）起查。
const { getCliHighlightPromise } = await import('../src/terminal-utils/cliHighlight.js')
await getCliHighlightPromise()
check(
  'code block: body picks up cli-highlight colours once loaded',
  await settled(() => {
    const rows = code.lines()
    const row = rows.findIndex(line => line.includes('const a = 1'))
    if (row < 0) return false
    for (let x = 2; x <= 80; x += 1) {
      const cell = code.cell(x, row)
      if (cell !== undefined && !cell.isFgDefault()) return true
    }
    return false
  }),
)
await code.close()

const tagged = await openPanelScreen(taggedPanelId, 38, 20)
check(
  'code block: prompt-analysis tags stay in raw code',
  await settled(() => {
    const rows = tagged.lines()
    return rows.some(line => line.includes('<context>')) &&
      rows.some(line => line.includes('kept line')) &&
      rows.some(line => line.includes('</context>'))
  }),
)
check(
  'code block: tagged body keeps all five rows in one frame',
  tagged.lines().filter(line => line.startsWith('│ ')).length === 5,
  'rail rows=' + String(tagged.lines().filter(line => line.startsWith('│ ')).length),
)
await tagged.close()

check('fenced(): plain body gets three backticks', fenced('x').startsWith('```\n'))
check('fenced(): an inner ``` run gets four', fenced('a\n```\nb').startsWith('````\n'))
check('fenced(): an inner ````` run gets six', fenced('a\n`````\nb').startsWith('``````\n'))
check('fenced(): the language label sheds backticks and spaces', fenced('x', 'ts`\n````').startsWith('```ts\n'))

richDispose?.()
codeDispose?.()
taggedDispose?.()

rmSync(ledgerDir, { recursive: true, force: true })
if (failed > 0) {
  console.error('verify-plugin-panels FAILED: ' + failed)
  process.exit(1)
}
console.log('verify-plugin-panels ALL PASS')
