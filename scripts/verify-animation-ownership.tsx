/** #1207: animation frames must not revisit a settled long transcript.
 * Mounts real Chat, MiniWake and session rows in the terminal renderer.
 * Run: node --import tsx/esm scripts/verify-animation-ownership.tsx */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-animation-ownership-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
process.env.DSH_TUI_LANG = 'en'
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'

const [React, { Writable, PassThrough }, { Terminal }, ui, { PageMargin }, { Chat }, { SessionSupervisor },
  { QuestionStore }, { MiniWake }, { SessionListRow }, { ClockContext },
  { default: FocusContext }, { sleep, settled, viewportLines }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/PageMargin.js'), import('../src/screens/Chat.js'),
  import('../src/screens/SessionSupervisor.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/components/trajectory/MiniWake.js'),
  import('../src/components/sessions/SessionListRow.js'), import('../src/ink/components/ClockContext.js'),
  import('../src/ink/components/TerminalFocusContext.js'), import('./lib/term-test.mjs'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
  if (!ok) failures++
}

async function mount(node: React.ReactNode) {
  const term = new Terminal({ cols: 120, rows: 34, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  const titles: string[] = []
  // Windows uses process.title instead of OSC 0; sample the same visible
  // property without replacing the production hook's setter.
  const titleTimer = process.platform === 'win32'
    ? setInterval(() => titles.push(process.title), 120) : undefined
  class Output extends Writable {
    isTTY = true
    columns = 120
    rows = 34
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
      writes.push(String(chunk))
      if (String(chunk).includes('\x1b]0;')) titles.push(String(chunk))
      term.write(String(chunk), done)
    }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const input = new Input()
  const app = await ui.render(node, {
    stdout: new Output() as never, stdin: input as never,
    stderr: new Writable({ write(_chunk, _encoding, done) { done() } }) as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  return { app, input, term, writes, titles, screen: () => viewportLines(term).join('\n'),
    close: async () => {
      if (titleTimer !== undefined) clearInterval(titleTimer)
      await app.unmount()
      term.dispose()
    } }
}

try {
  const listeners = new Set<() => void>()
  const rows = Array.from({ length: 4000 }, (_, id) => ({
    id, kind: id % 2 === 0 ? 'user' : 'assistant', text: `history-${id}`, time: id,
  }))
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'pending', name: 'long_task', arguments: '{}' } },
  ]
  let chatReads = 0
  let transcriptReads = 0
  const channel = {
    version: 0, get rows() { transcriptReads++; return rows },
    // Chat reads this public snapshot once per render; leaf timers need no
    // new snapshot. Counting the boundary avoids production instrumentation.
    traceEvents() { chatReads++; return events },
    status: 'working', working: true, sessionTitle: 'animation-ownership',
    sessionId: 'animation', agentId: 'animation', model: 'deepseek-v4-flash',
    reasoningEffort: 'max', tokens: { input: 0, output: 0 }, cwd: home, displayCwd: home,
    gitBranch: 'main', spinnerMode: 'requesting', responseChars: 0, whale: false,
    whaleIdle: false, activeToolCount: 0, turnStart: Date.now(), lastUserText: '',
    pending: [], commandList: [], notifications: [], mode: { plan: false },
    statusBar: { trajectory: false, activity: false },
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn) },
    submit() {}, cancel() {}, clear() {}, notify() {}, listModels: async () => [],
    listSessions: async () => [], setResumeTarget() {}, loadOlder() {}, mcpStatus: () => [],
  }
  const update = () => { channel.version++; for (const fn of listeners) fn() }
  const screen = await mount(
    <PageMargin><ui.AlternateScreen><Chat channel={channel as never} questionStore={new QuestionStore()}
      fullscreen starPrompt={null} trajectorySeen /></ui.AlternateScreen></PageMargin>,
  )
  try {
    assert(await settled(() => screen.screen().includes('history-3999')), screen.screen())
    for (const trajectory of [false, true]) {
      channel.statusBar.trajectory = trajectory
      update()
      // 固定窗:pacing Let the explicit channel update and scroll measurement settle before the clock-only window.
      await sleep(300)
      chatReads = 0
      transcriptReads = 0
      screen.writes.length = 0
      screen.titles.length = 0
      const cpu = process.cpuUsage()
      // 固定窗:墙钟 The ten-second window is the measured invariant, with no input or data changes.
      await sleep(10_000)
      const used = process.cpuUsage(cpu)
      const titles = screen.titles.filter(title => title.includes('animation-ownership'))
      check(`4000 rows, trajectory=${trajectory}: no Chat snapshot reads`, chatReads === 0, String(chatReads))
      check(`4000 rows, trajectory=${trajectory}: no transcript reads`, transcriptReads === 0, String(transcriptReads))
      check(`4000 rows, trajectory=${trajectory}: title animation continues`, new Set(titles).size >= 2)
      console.log(`SAMPLE trajectory=${trajectory} cpu_us=${used.user + used.system} writes=${screen.writes.length}`)
    }
    rows.at(-1)!.text = 'streamed-tail'
    update()
    check('channel delta still reaches the transcript', await settled(() => screen.screen().includes('streamed-tail')))
    screen.input.write('draft-kept')
    check('composer still accepts input', await settled(() => screen.screen().includes('draft-kept')))
    console.log('RENDER\n' + screen.screen())
    screen.input.write('\x1b[O')
    // 固定窗:pacing Flush the focus transition before observing the paused title.
    await sleep(200)
    screen.titles.length = 0
    // 固定窗:探针 A blurred title must stay still for longer than its 960ms period.
    await sleep(1100)
    check('blur pauses the terminal-title animation', process.platform === 'win32'
      ? new Set(screen.titles).size === 1 : screen.titles.length === 0)
    screen.input.write('\x1b[I')
    channel.working = false
    channel.status = 'idle'
    update()
    check('idle restores the static terminal title', await settled(() => screen.titles.some(title => title.includes('✦ 🐋 animation-ownership'))))
  } finally { await screen.close() }

  // Isolate the mounted decorations to prove that hiding, idling or blurring
  // releases their clock subscription, and that their own ticks still paint.
  let now = 0
  const subscribers = new Set<() => void>()
  const clock = {
    now: () => now, setTickInterval() {}, suspend() {},
    subscribe(fn: () => void) { subscribers.add(fn); return () => subscribers.delete(fn) },
  }
  const band = { buckets: [{ count: 1, weight: 1, running: true, error: false, retry: false }], floor: 0, peak: 1 }
  const session = { id: 'row', kind: { kind: 'root' }, title: { text: 'working-row', source: 'prompt' },
    cwd: home, createdAt: 0, updatedAt: 0, hasPrompt: true, childCount: 0 }
  const node = (focused: boolean, working: boolean, shown: boolean) => (
    <ClockContext.Provider value={clock}>
      <FocusContext.Provider value={{ isTerminalFocused: focused, terminalFocusState: focused ? 'focused' : 'blurred' }}>
        {shown ? <ui.Box flexDirection="column">
          <MiniWake band={band as never} working={working} />
          <SessionListRow session={session as never} width={110} depth={0} focused={false} pinned={false}
            now={0} liveStatus={working ? 'working' : 'idle'} />
        </ui.Box> : null}
      </FocusContext.Provider>
    </ClockContext.Provider>
  )
  const leaves = await mount(node(true, true, true))
  try {
    check('only visible working decorations subscribe', await settled(() => subscribers.size === 2), String(subscribers.size))
    const before = leaves.writes.length
    now += 240
    for (const fn of subscribers) fn()
    check('leaf clock ticks still paint', await settled(() => leaves.writes.length > before))
    for (const [focused, working, shown] of [[false, true, true], [true, false, true], [true, true, false]]) {
      leaves.app.rerender(node(focused!, working!, shown!))
      check(`decorations pause: focus=${focused}, working=${working}, shown=${shown}`,
        await settled(() => subscribers.size === 0), String(subscribers.size))
    }
  } finally { await leaves.close() }
  check('unmount releases every decoration subscription', subscribers.size === 0)

  let liveReads = 0
  const supervisorChannel = {
    version: 0, cwd: home, working: false, agentId: 'row',
    backendCapabilities: { backendId: 'codex', backendLabel: 'Codex', commands: [] },
    cachedSessions: () => [session], listSessions: async () => [session],
    subscribe: () => () => {}, notify() {},
  }
  const supervisor = await mount(
    <ClockContext.Provider value={clock}>
      <ui.AlternateScreen><SessionSupervisor channel={supervisorChannel as never} home={home}
        onClose={() => {}} onOpenSession={async () => ({ ok: true })} onNewSession={async () => true}
        onStopSession={async () => true} approval={null} onApprove={() => {}}
        liveStateOf={() => { liveReads++; return { status: 'working', live: true, current: true, summary: '' } }} />
      </ui.AlternateScreen>
    </ClockContext.Provider>,
  )
  try {
    assert(await settled(() => supervisor.screen().includes('working-row') && subscribers.size > 0), supervisor.screen())
    // 固定窗:pacing Let initial catalog completion settle; the 2s occupancy pulse is intentionally retained.
    await sleep(100)
    liveReads = 0
    const writes = supervisor.writes.length
    now += 240
    for (const fn of subscribers) fn()
    check('supervisor working glyph still paints', await settled(() => supervisor.writes.length > writes))
    check('an animation tick does not rescan supervisor live states', liveReads === 0, String(liveReads))
  } finally { await supervisor.close() }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} checks failed`)
process.exitCode = failures === 0 ? 0 : 1
