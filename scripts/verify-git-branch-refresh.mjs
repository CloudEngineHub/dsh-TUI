#!/usr/bin/env node
/**
 * The statusline git-branch breadcrumb (`ChannelState.gitBranch`) must follow
 * the workspace HEAD, not freeze at boot. `createGitBranchRefresher` in
 * `dsh-adapter/channel/core/host.ts` probes `git branch --show-current` only
 * at four semantic moments (start, startup adoption, /resume, workspace
 * switch), so before this guard a branch checked out in another terminal
 * stayed invisible until the TUI restarted — while the statusline, `/status`
 * and the side panel all read that same field.
 *
 * These checks drive a real `createChannel` over a throwaway cwd (fake host
 * shell whose answer the test can change, plus a self-made `.git` directory),
 * so what is guarded is the field those three consumers read:
 *
 * - a rewritten `.git/HEAD` reaches `gitBranch` without rebuilding the channel;
 * - a detached HEAD (the shell answers empty) clears it instead of keeping a
 *   stale name;
 * - an unchanged HEAD neither re-runs the probe nor redraws;
 * - `releaseContributions()` stops the refresh for good;
 * - a cwd without `.git` stays quiet: no probe, no throw, no value change;
 * - a linked worktree (`.git` is a `gitdir:` file) follows its real git dir,
 *   both with an absolute target and with the relative one git writes for a
 *   submodule;
 * - a reply from an older probe that lands after a newer one does not
 *   overwrite the newer branch.
 *
 * Reads the compiled output, so `pnpm compile` must have produced `lib/types/`:
 *   node scripts/verify-git-branch-refresh.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settled, sleep } from './lib/term-test.mjs'

const scratch = []
/** A temp directory this script owns and removes when it ends. */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

// Every home the channel composition reads is redirected before the modules
// load: preferences and the session index must never land in the real profile.
const home = tempDir('dsh-tui-git-branch-home-')
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home

const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

const HEAD_REF = branch => `ref: refs/heads/${branch}\n`
/** What git writes when HEAD is detached: 40 lowercase hex digits, no `ref:`. */
const HEAD_DETACHED = '0123456789abcdef0123456789abcdef01234567\n'
/** A rewritten HEAD must land well inside this bound (the refresh polls once a second). */
const DETECT_TIMEOUT_MS = 4000
/** One poll period plus slack: long enough that a quiet window proves quiescence. */
const POLL_WINDOW_MS = 1500
/** A standalone repository: the refresh only ever reads `<repo>/.git/HEAD`. */
function makeRepo() {
  const repo = tempDir('dsh-tui-repo-')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), HEAD_REF('main'))
  return repo
}
/** A linked worktree: `.git` is a file pointing at the real git dir. */
function makeLinkedWorktree() {
  const main = tempDir('dsh-tui-worktree-main-')
  const gitdir = join(main, '.git', 'worktrees', 'linked')
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(gitdir, 'HEAD'), HEAD_REF('main'))
  const cwd = tempDir('dsh-tui-worktree-linked-')
  // Real git writes the gitdir with forward slashes, even on Windows.
  writeFileSync(join(cwd, '.git'), `gitdir: ${gitdir.replaceAll('\\', '/')}\n`)
  return { cwd, gitdir }
}
/** A submodule: `.git` is a file with the *relative* gitdir git writes for it. */
function makeSubmodule() {
  const repo = tempDir('dsh-tui-submodule-')
  const gitdir = join(repo, '.git', 'modules', 'sub')
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(gitdir, 'HEAD'), HEAD_REF('main'))
  const cwd = join(repo, 'sub')
  mkdirSync(cwd, { recursive: true })
  // Resolved against the directory holding the `.git` file, never the cwd.
  writeFileSync(join(cwd, '.git'), 'gitdir: ../.git/modules/sub\n')
  return { cwd, gitdir }
}

/**
 * A channel over `cwd` whose host shell answers `git branch --show-current`
 * with the test's current text. `probes` records every `resolve()` call, so a
 * check can tell whether a poll tick actually reached the shell.
 */
function openChannel(cwd, branch) {
  let stdout = `${branch}\n`
  /** Once held, each later probe parks until the test opens its gate. */
  let held = false
  let parkedReplies = 0
  const probes = []
  const gates = []
  const shell = {
    resolve(request) {
      probes.push(request)
      return request
    },
    async execute() {
      // Snapshot the answer at issue time: a reply says what was checked out
      // when the probe was sent, which is what a slow shell delivers.
      const reply = stdout
      const parked = held
      let open
      const gate = new Promise(resolve => { open = resolve })
      if (parked) gates.push(open)
      else open()
      return {
        async result() {
          await gate
          if (parked) parkedReplies += 1
          return { stdout: { text: reply }, stderr: { text: '' }, timedOut: false }
        },
      }
    },
  }
  const ctx = { on: () => () => {}, get: name => name === 'shell' ? shell : undefined, logger: { warn() {} } }
  const agent = {
    id: 'git-branch-agent', status: 'idle', session: { id: 'git-branch-session', seq: 0, events: [] },
    ctx: { on: () => () => {} }, followup: () => {},
  }
  return {
    channel: createChannel(ctx, agent, { cwd, model: 'deepseek-chat', provider: 'deepseek', activity: false }),
    probes,
    /** What the next probe answers; '' is a detached HEAD (no branch name). */
    answer(text) { stdout = text },
    /** Park every later probe; `gates` then holds their open callbacks. */
    hold() { held = true },
    gates,
    /** Replies the parked probes have delivered, so a check can wait for them. */
    parkedReplies: () => parkedReplies,
  }
}

/** Count redraws through the channel's own `emit` (the refresher calls it). */
function countEmits(channel) {
  const counter = { count: 0 }
  const original = channel.emit
  channel.emit = (...args) => {
    counter.count += 1
    return original(...args)
  }
  return counter
}

/** Rejections no `catch` claimed — a poll tick must never escape that way. */
const unhandled = []
process.on('unhandledRejection', error => { unhandled.push(error) })

const results = []
const describe = error => error instanceof Error ? error.message.split('\n')[0] : String(error)

/**
 * Run one check against its own channel and record PASS/FAIL instead of
 * aborting: a red run has to show every check's landing point at once.
 */
async function scenario(name, { cwd, branch }, body) {
  const opened = openChannel(cwd, branch)
  let failure
  try {
    await body(opened)
  } catch (error) {
    failure = error
  } finally {
    // Release is idempotent (owner, emitter and IDE channel each guard their
    // own teardown), and one check releases inside its body on purpose.
    opened.channel.releaseContributions()
  }
  results.push({ name, failure })
  console.log(failure === undefined ? `PASS ${name}` : `FAIL ${name}\n     ${describe(failure)}`)
}

try {
  const repo = makeRepo()
  await scenario('AC-1 the breadcrumb follows a HEAD rewritten outside the TUI', { cwd: repo, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    writeFileSync(join(repo, '.git', 'HEAD'), HEAD_REF('feature-x'))
    answer('feature-x\n')
    assert.ok(await settled(() => channel.gitBranch === 'feature-x', { timeoutMs: DETECT_TIMEOUT_MS }),
      `the breadcrumb must follow the new HEAD without rebuilding the channel (saw ${String(channel.gitBranch)})`)
  })

  // 1 Hz polling lets two probes overlap (the host shell does not serialize
  // them), so a reply says what was checked out when it was *sent*: the older
  // one landing last must not win.
  const orderedRepo = makeRepo()
  await scenario('AC-1b a slow reply must not overwrite a newer branch', { cwd: orderedRepo, branch: 'main' }, async ({ channel, answer, hold, gates, parkedReplies }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    hold()
    writeFileSync(join(orderedRepo, '.git', 'HEAD'), HEAD_REF('first'))
    answer('first\n')
    assert.ok(await settled(() => gates.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the first HEAD change must issue a probe')
    writeFileSync(join(orderedRepo, '.git', 'HEAD'), HEAD_REF('second'))
    answer('second\n')
    assert.ok(await settled(() => gates.length === 2, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the second HEAD change must issue a probe while the first is still in flight')
    // Out of order on purpose: the newer answer lands first, then the older
    // one — the order a slow first shell run produces.
    gates[1]()
    gates[0]()
    assert.ok(await settled(() => parkedReplies() === 2, { timeoutMs: DETECT_TIMEOUT_MS }),
      'both parked replies must land before the value is read')
    // Reading after the second landing is a fresh timer tick, so a stale reply
    // that overwrote the value has already run its handler.
    assert.equal(channel.gitBranch, 'second',
      `a slow earlier reply must not overwrite the newer branch (saw ${String(channel.gitBranch)})`)
  })

  const detachedRepo = makeRepo()
  await scenario('AC-2 a detached HEAD clears the breadcrumb', { cwd: detachedRepo, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    writeFileSync(join(detachedRepo, '.git', 'HEAD'), HEAD_DETACHED)
    answer('')
    assert.ok(await settled(() => channel.gitBranch === undefined, { timeoutMs: DETECT_TIMEOUT_MS }),
      `a detached HEAD must clear the stale branch instead of keeping it (saw ${String(channel.gitBranch)})`)
  })

  const steadyRepo = makeRepo()
  await scenario('AC-3 an unchanged HEAD neither re-probes nor redraws', { cwd: steadyRepo, branch: 'main' }, async ({ channel, probes }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    // 固定窗:探针 let the boot probe and any first-tick baseline capture land; only steady state is the invariant
    await sleep(POLL_WINDOW_MS)
    const probesAtStart = probes.length
    const emits = countEmits(channel)
    // 固定窗:探针 an unchanged HEAD must stay silent: polling an already-true condition would prove nothing
    await sleep(POLL_WINDOW_MS)
    assert.equal(probes.length, probesAtStart, 'an unchanged HEAD must not re-run `git branch --show-current`')
    assert.equal(emits.count, 0, 'an unchanged HEAD must not redraw the statusline')
  })

  const releasedRepo = makeRepo()
  await scenario('AC-4 releasing the channel stops the refresh', { cwd: releasedRepo, branch: 'main' }, async ({ channel, probes, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    channel.releaseContributions()
    const probesAtRelease = probes.length
    writeFileSync(join(releasedRepo, '.git', 'HEAD'), HEAD_REF('after-release'))
    answer('after-release\n')
    // 固定窗:探针 a released channel must never probe again: that is an invariant, so it needs an observation window
    await sleep(POLL_WINDOW_MS)
    assert.equal(probes.length, probesAtRelease, 'a released channel must not probe the shell again')
    assert.equal(channel.gitBranch, 'main', 'a late reply must not reach a released channel')
  })

  const noRepo = tempDir('dsh-tui-no-repo-')
  await scenario('AC-5 a cwd without .git stays quiet', { cwd: noRepo, branch: 'main' }, async ({ channel, probes }) => {
    // 固定窗:探针 no `.git` means no pollable ready anchor: let boot and one poll period pass first
    await sleep(POLL_WINDOW_MS)
    const probesAtBoot = probes.length
    const branchAtBoot = channel.gitBranch
    // 固定窗:探针 a non-repository must not be re-probed or rewritten: polling an already-true condition proves nothing
    await sleep(POLL_WINDOW_MS)
    assert.equal(probes.length, probesAtBoot, 'a cwd without .git must not be probed on every tick')
    assert.equal(channel.gitBranch, branchAtBoot, 'a cwd without .git must not change the breadcrumb')
    assert.equal(unhandled.length, 0, 'a cwd without .git must not throw out of the refresh')
  })

  /**
   * Both `gitdir:` forms end at the HEAD of a git dir outside the worktree;
   * only how the worktree records it differs.
   */
  const gitdirScenario = (name, { cwd, gitdir }) => scenario(name, { cwd, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    writeFileSync(join(gitdir, 'HEAD'), HEAD_REF('feature-wt'))
    answer('feature-wt\n')
    assert.ok(await settled(() => channel.gitBranch === 'feature-wt', { timeoutMs: DETECT_TIMEOUT_MS }),
      `a .git gitdir file must resolve to the worktree's HEAD (saw ${String(channel.gitBranch)})`)
  })

  await gitdirScenario('AC-6 a linked worktree follows its git dir HEAD', makeLinkedWorktree())
  await gitdirScenario('AC-6b a relative gitdir file resolves against the worktree', makeSubmodule())
} finally {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter(result => result.failure !== undefined)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  console.log(`FAILED: ${failed.map(result => result.name).join(', ')}`)
}
