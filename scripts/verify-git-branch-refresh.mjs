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
 *   overwrite the newer branch;
 * - a failed or mismatched probe retries, and a reply after HEAD disappears
 *   stays discarded, including a B-C-B checkout between polls;
 * - deep cwd paths, git init, and gitdir retargeting stay observable;
 * - slow async reads do not pile up or escape a released owner or changed cwd;
 * - symlink cwd paths and a returning optional shell still refresh;
 * - oversized or non-regular Git control files are rejected without blocking;
 * - persistent failures back off without losing same-HEAD recovery or delaying
 *   a new checkout.
 *
 * Reads the compiled output, so `pnpm compile` must have produced `lib/types/`:
 *   node scripts/verify-git-branch-refresh.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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

/** Hold one real file's async results; every other filesystem read stays real. */
function holdHeadReads(headPath) {
  const originalReadFile = fs.readFile
  const originalOpen = fs.open
  const paths = new Set([headPath, realpathSync(headPath)])
  let reads = 0
  let completed = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const hold = async (result, countCompleted = true) => {
    reads += 1
    await gate
    if (countCompleted) completed += 1
    return result
  }
  fs.readFile = async (...args) => {
    const result = await originalReadFile(...args)
    return paths.has(args[0]) ? hold(result) : result
  }
  fs.open = async (...args) => {
    const file = await originalOpen(...args)
    if (paths.has(args[0])) {
      const read = file.read.bind(file)
      const close = file.close.bind(file)
      let first = true
      file.read = async (...readArgs) => {
        const result = await read(...readArgs)
        if (!first) return result
        first = false
        return hold(result, false)
      }
      file.close = async (...closeArgs) => {
        try { return await close(...closeArgs) }
        finally { if (!first) completed += 1 }
      }
    }
    return file
  }
  syncBuiltinESMExports()
  return {
    reads: () => reads,
    completed: () => completed,
    release,
    restore() { release(); fs.readFile = originalReadFile; fs.open = originalOpen; syncBuiltinESMExports() },
  }
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
  let shellAvailable = true
  let missingShellLookups = 0
  const probes = []
  const gates = []
  const failures = []
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
      const failure = failures.shift()
      let open
      const gate = new Promise(resolve => { open = resolve })
      if (parked) gates.push(open)
      else open()
      return {
        async result() {
          const delivered = await gate
          if (parked) parkedReplies += 1
          if (failure === 'reject') throw new Error('temporary shell failure')
          return { stdout: { text: delivered ?? reply }, stderr: { text: '' }, timedOut: failure === 'timeout' }
        },
      }
    },
  }
  const ctx = { on: () => () => {}, get(name) {
    if (name !== 'shell') return undefined
    if (shellAvailable) return shell
    missingShellLookups += 1
    return undefined
  }, logger: { warn() {} } }
  const agent = {
    id: 'git-branch-agent', status: 'idle', session: { id: 'git-branch-session', seq: 0, events: [] },
    ctx: { on: () => () => {} }, followup: () => {},
  }
  return {
    channel: createChannel(ctx, agent, { cwd, model: 'deepseek-chat', provider: 'deepseek', activity: false }),
    probes,
    /** What the next probe answers; '' is a detached HEAD (no branch name). */
    answer(text) { stdout = text },
    failNext(kind) { failures.push(kind) },
    setShellAvailable(value) { shellAvailable = value },
    missingShellLookups: () => missingShellLookups,
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
  await scenario('the breadcrumb follows a HEAD rewritten outside the TUI', { cwd: repo, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    writeFileSync(join(repo, '.git', 'HEAD'), HEAD_REF('feature-x'))
    answer('feature-x\n')
    assert.ok(await settled(() => channel.gitBranch === 'feature-x', { timeoutMs: DETECT_TIMEOUT_MS }),
      `the breadcrumb must follow the new HEAD without rebuilding the channel (saw ${String(channel.gitBranch)})`)
  })

  for (const failure of ['timeout', 'reject']) {
    const retryRepo = makeRepo()
    await scenario(`a ${failure} retries without another HEAD change`, { cwd: retryRepo, branch: 'main' }, async ({ channel, answer, failNext, probes }) => {
      assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
      failNext(failure)
      answer('feature-retry')
      writeFileSync(join(retryRepo, '.git', 'HEAD'), HEAD_REF('feature-retry'))
      assert.ok(await settled(() => probes.length === 2, { timeoutMs: DETECT_TIMEOUT_MS }),
        'the changed HEAD must issue the failing probe')
      assert.equal(channel.gitBranch, 'main', 'a failed probe must retain the last known branch')
      assert.ok(await settled(() => channel.gitBranch === 'feature-retry', { timeoutMs: DETECT_TIMEOUT_MS }),
        'the same HEAD must be retried after the transient failure')
      assert.equal(probes.length, 3, 'one retry must recover the branch')
    })
  }

  const backoffRepo = makeRepo()
  await scenario('persistent failures back off, recover, and let a new HEAD through', { cwd: backoffRepo, branch: 'main' }, async ({ channel, answer, failNext, probes }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    // Only the monotonic deadline clock is controlled. The channel, metadata
    // reads, shell replies and 1 Hz polling timer all follow their real paths.
    const originalNow = performance.now
    let now = originalNow.call(performance)
    performance.now = () => now
    try {
      const bootProbes = probes.length
      answer('')
      for (const failure of [undefined, 'timeout', 'reject', undefined, 'timeout', 'reject', undefined]) failNext(failure)
      writeFileSync(join(backoffRepo, '.git', 'HEAD'), HEAD_REF('retry-budget'))
      const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
      for (const [index, delay] of delays.entries()) {
        const expected = bootProbes + index + 1
        assert.ok(await settled(() => probes.length === expected, { timeoutMs: DETECT_TIMEOUT_MS }),
          'the same HEAD must remain retryable beyond three failures and at the cap')
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(channel.gitBranch, 'main', 'a failed probe must retain the last known branch')
        now += delay - 1
        // 固定窗:探针 real poll ticks must remain quiet before the controlled retry deadline
        await sleep(POLL_WINDOW_MS)
        assert.equal(probes.length, expected, 'unchanged failing HEAD must not launch git before its retry deadline')
        now += 1
      }
      answer('retry-budget')
      assert.ok(await settled(() => channel.gitBranch === 'retry-budget', { timeoutMs: DETECT_TIMEOUT_MS }),
        'the unchanged HEAD must still recover after repeated capped retries')

      // Establish a two-second retry, then change HEAD without advancing the
      // deadline clock. The new signature must bypass and reset that delay.
      answer('')
      writeFileSync(join(backoffRepo, '.git', 'HEAD'), HEAD_REF('before-reset'))
      const beforeReset = probes.length
      assert.ok(await settled(() => probes.length === beforeReset + 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      await new Promise(resolve => setImmediate(resolve))
      now += 1000
      assert.ok(await settled(() => probes.length === beforeReset + 2, { timeoutMs: DETECT_TIMEOUT_MS }))
      await new Promise(resolve => setImmediate(resolve))
      writeFileSync(join(backoffRepo, '.git', 'HEAD'), HEAD_REF('after-reset'))
      assert.ok(await settled(() => probes.length === beforeReset + 3, { timeoutMs: DETECT_TIMEOUT_MS }),
        'a changed HEAD must bypass the previous signature retry deadline')
      await new Promise(resolve => setImmediate(resolve))
      answer('after-reset')
      now += 1000
      assert.ok(await settled(() => channel.gitBranch === 'after-reset', { timeoutMs: DETECT_TIMEOUT_MS }),
        'a changed HEAD must reset the failure delay to the first retry interval')
    } finally { performance.now = originalNow }
  })

  // 1 Hz polling lets two probes overlap (the host shell does not serialize
  // them), so a reply says what was checked out when it was *sent*: the older
  // one landing last must not win.
  const orderedRepo = makeRepo()
  await scenario('a slow reply must not overwrite a newer branch', { cwd: orderedRepo, branch: 'main' }, async ({ channel, answer, hold, gates, parkedReplies }) => {
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
  await scenario('a detached HEAD clears the breadcrumb', { cwd: detachedRepo, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    writeFileSync(join(detachedRepo, '.git', 'HEAD'), HEAD_DETACHED)
    answer('')
    assert.ok(await settled(() => channel.gitBranch === undefined, { timeoutMs: DETECT_TIMEOUT_MS }),
      `a detached HEAD must clear the stale branch instead of keeping it (saw ${String(channel.gitBranch)})`)
  })

  const steadyRepo = makeRepo()
  await scenario('an unchanged HEAD neither re-probes nor redraws', { cwd: steadyRepo, branch: 'main' }, async ({ channel, probes }) => {
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
  await scenario('releasing the channel stops the refresh', { cwd: releasedRepo, branch: 'main' }, async ({ channel, probes, answer, hold, gates, parkedReplies }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    // Park a probe in flight, then release the channel: the reply that lands
    // afterwards is the one a released channel must ignore. Releasing with no
    // probe pending would leave the "late reply" half of this check untested.
    hold()
    writeFileSync(join(releasedRepo, '.git', 'HEAD'), HEAD_REF('after-release'))
    answer('after-release\n')
    assert.ok(await settled(() => gates.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the HEAD change must issue a probe before the channel is released')
    channel.releaseContributions()
    const probesAtRelease = probes.length
    gates[0]()
    assert.ok(await settled(() => parkedReplies() === 1, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the parked reply must be delivered while the channel is released')
    // 固定窗:探针 a released channel must never probe again: that is an invariant, so it needs an observation window
    await sleep(POLL_WINDOW_MS)
    assert.equal(probes.length, probesAtRelease, 'a released channel must not probe the shell again')
    assert.equal(channel.gitBranch, 'main', 'a reply landing after release must not reach the channel')
  })

  const vanishedRepo = makeRepo()
  await scenario('a vanishing HEAD clears the breadcrumb and rejects an in-flight reply', { cwd: vanishedRepo, branch: 'main' }, async ({ channel, answer, hold, gates, parkedReplies }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the boot probe must publish the branch the host shell reports')
    hold()
    answer('feature-vanished')
    writeFileSync(join(vanishedRepo, '.git', 'HEAD'), HEAD_REF('feature-vanished'))
    assert.ok(await settled(() => gates.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }),
      'a probe must be in flight when HEAD disappears')
    rmSync(join(vanishedRepo, '.git'), { recursive: true, force: true })
    assert.ok(await settled(() => channel.gitBranch === undefined, { timeoutMs: DETECT_TIMEOUT_MS }),
      `a repository that disappears must clear the branch instead of keeping it (saw ${String(channel.gitBranch)})`)
    gates[0]()
    assert.ok(await settled(() => parkedReplies() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
    assert.equal(channel.gitBranch, undefined, 'a reply for the vanished HEAD must not restore the branch')
  })

  const noRepo = tempDir('dsh-tui-no-repo-')
  await scenario('a cwd without .git stays quiet', { cwd: noRepo, branch: 'main' }, async ({ channel, probes }) => {
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

  await gitdirScenario('a linked worktree follows its git dir HEAD', makeLinkedWorktree())
  await gitdirScenario('a relative gitdir file resolves against the worktree', makeSubmodule())

  if (process.platform === 'win32') {
    console.log('SKIP a legacy symlink HEAD follows the branch target: POSIX file-symlink fixture')
  } else {
    const legacyRepo = tempDir('dsh-tui-legacy-head-')
    const git = (...args) => execFileSync('git', ['-C', legacyRepo, ...args], { encoding: 'utf8' }).trim()
    git('init', '--quiet', '--initial-branch=main')
    git('-c', 'user.name=Regression Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'local fixture')
    git('branch', 'legacy-feature')
    git('config', 'core.preferSymlinkRefs', 'true')
    git('symbolic-ref', 'HEAD', 'refs/heads/main')
    await scenario('a legacy symlink HEAD follows its branch target even at the same commit', { cwd: legacyRepo, branch: git('branch', '--show-current') }, async ({ channel, answer }) => {
      assert.equal(readlinkSync(join(legacyRepo, '.git', 'HEAD')), 'refs/heads/main')
      const commit = git('rev-parse', 'HEAD')
      assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }),
        'Git symbolic HEAD links must not be misclassified as detached hashes')
      git('switch', '--quiet', 'legacy-feature')
      assert.equal(readlinkSync(join(legacyRepo, '.git', 'HEAD')), 'refs/heads/legacy-feature')
      assert.equal(git('rev-parse', 'HEAD'), commit, 'the branch target changes while the dereferenced hash stays the same')
      answer(git('branch', '--show-current'))
      assert.ok(await settled(() => channel.gitBranch === 'legacy-feature', { timeoutMs: DETECT_TIMEOUT_MS }),
        'the symlink target must be the symbolic HEAD signature')
    })
  }

  const deepRepo = makeRepo()
  const deepCwd = join(deepRepo, ...Array.from({ length: 10 }, (_, index) => `level-${index}`))
  mkdirSync(deepCwd, { recursive: true })
  await scenario('a cwd more than eight levels below the repo follows HEAD', { cwd: deepCwd, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    answer('deep-branch')
    writeFileSync(join(deepRepo, '.git', 'HEAD'), HEAD_REF('deep-branch'))
    assert.ok(await settled(() => channel.gitBranch === 'deep-branch', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the poll must find every repository the initial git command can find')
  })

  const initializedRepo = tempDir('dsh-tui-late-init-')
  await scenario('git init after startup becomes observable at the same cwd', { cwd: initializedRepo, branch: '' }, async ({ channel, answer, probes }) => {
    assert.ok(await settled(() => probes.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
    mkdirSync(join(initializedRepo, '.git'))
    writeFileSync(join(initializedRepo, '.git', 'HEAD'), HEAD_REF('initialized'))
    answer('initialized')
    assert.ok(await settled(() => channel.gitBranch === 'initialized', { timeoutMs: DETECT_TIMEOUT_MS }),
      'a missing .git must not be cached for the lifetime of the channel')
  })

  const movedWorktree = makeLinkedWorktree()
  await scenario('a retargeted gitdir is followed even while the old HEAD exists', { cwd: movedWorktree.cwd, branch: 'main' }, async ({ channel, answer }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    const newGitdir = tempDir('dsh-tui-retargeted-gitdir-')
    writeFileSync(join(newGitdir, 'HEAD'), HEAD_REF('retargeted'))
    writeFileSync(join(movedWorktree.cwd, '.git'), `gitdir: ${newGitdir.replaceAll('\\', '/')}\n`)
    answer('retargeted')
    assert.ok(await settled(() => channel.gitBranch === 'retargeted', { timeoutMs: DETECT_TIMEOUT_MS }),
      'a .git pointer change must invalidate the previous target without requiring its deletion')
  })

  for (const [name, baseline, branch] of [
    ['B-C-B', HEAD_REF('branch-b'), 'branch-b'],
    ['detached-C-detached', HEAD_DETACHED, ''],
  ]) {
    const abaRepo = makeRepo()
    await scenario(`a ${name} checkout cannot publish a reply for transient C`, { cwd: abaRepo, branch: 'main' }, async ({ channel, answer, hold, gates, parkedReplies }) => {
      assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
      hold()
      answer(branch)
      writeFileSync(join(abaRepo, '.git', 'HEAD'), baseline)
      assert.ok(await settled(() => gates.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      // Git can execute after the probe was issued. It reads C, but another
      // checkout restores the baseline before the handler or next poll runs.
      writeFileSync(join(abaRepo, '.git', 'HEAD'), HEAD_REF('transient-c'))
      gates[0]('transient-c')
      writeFileSync(join(abaRepo, '.git', 'HEAD'), baseline)
      assert.ok(await settled(() => parkedReplies() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      assert.equal(channel.gitBranch, 'main', 'a reply that disagrees with the observed HEAD must stay unpublished')
      assert.ok(await settled(() => gates.length === 2, { timeoutMs: DETECT_TIMEOUT_MS }),
        'the unchanged baseline still needs a retry after the mismatched reply')
      gates[1]()
      assert.ok(await settled(() => channel.gitBranch === (branch || undefined), { timeoutMs: DETECT_TIMEOUT_MS }))
    })
  }

  const slowRepo = makeRepo()
  await scenario('one slow HEAD read stays bounded and cannot probe after release', { cwd: slowRepo, branch: 'main' }, async ({ channel, answer, probes }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    const held = holdHeadReads(join(slowRepo, '.git', 'HEAD'))
    try {
      answer('after-read')
      writeFileSync(join(slowRepo, '.git', 'HEAD'), HEAD_REF('after-read'))
      assert.ok(await settled(() => held.reads() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      // 固定窗:探针 keep one read pending across multiple ticks to prove no queue accumulates
      await sleep(POLL_WINDOW_MS * 2)
      assert.equal(held.reads(), 1, 'a slow filesystem must not accumulate periodic reads')
      channel.releaseContributions()
      const probesAtRelease = probes.length
      held.release()
      assert.ok(await settled(() => held.completed() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      assert.equal(probes.length, probesAtRelease, 'a released owner must discard the pending read before probing')
      assert.equal(channel.gitBranch, 'main', 'the completed read must not mutate a released channel')
    } finally { held.restore() }
  })

  const staleReadRepo = makeRepo()
  const destinationRepo = makeRepo()
  writeFileSync(join(destinationRepo, '.git', 'HEAD'), HEAD_REF('destination'))
  await scenario('a HEAD read completing after cwd changes cannot probe the old workspace', { cwd: staleReadRepo, branch: 'main' }, async ({ channel, answer, probes }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    const held = holdHeadReads(join(staleReadRepo, '.git', 'HEAD'))
    try {
      writeFileSync(join(staleReadRepo, '.git', 'HEAD'), HEAD_REF('stale-read'))
      assert.ok(await settled(() => held.reads() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
      channel.cwd = destinationRepo
      answer('destination')
      held.release()
      assert.ok(await settled(() => channel.gitBranch === 'destination', { timeoutMs: DETECT_TIMEOUT_MS }))
      assert.ok(probes.slice(1).every(probe => probe.workdir === destinationRepo),
        'a read started at the old cwd must not issue a shell query after the switch')
    } finally { held.restore() }
  })

  const physicalRepo = makeRepo()
  const physicalCwd = join(physicalRepo, 'nested', 'project')
  mkdirSync(physicalCwd, { recursive: true })
  const linkedCwd = join(tempDir('dsh-tui-cwd-link-'), 'project')
  symlinkSync(physicalCwd, linkedCwd, process.platform === 'win32' ? 'junction' : 'dir')
  await scenario('a symlink cwd finds the repository above its physical target', { cwd: linkedCwd, branch: 'main' }, async ({ channel, answer, probes }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    writeFileSync(join(physicalRepo, '.git', 'HEAD'), HEAD_REF('physical-branch'))
    answer('physical-branch')
    assert.ok(await settled(() => channel.gitBranch === 'physical-branch', { timeoutMs: DETECT_TIMEOUT_MS }),
      'repository discovery must follow the target ancestors of a symlink cwd')
    assert.ok(probes.every(probe => probe.workdir === linkedCwd), 'the host shell keeps the requested workdir')
  })

  const missingShellRepo = makeRepo()
  await scenario('a temporarily absent shell retries the unchanged HEAD after remount', { cwd: missingShellRepo, branch: 'main' }, async ({ channel, answer, setShellAvailable, missingShellLookups }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    setShellAvailable(false)
    answer('remounted')
    writeFileSync(join(missingShellRepo, '.git', 'HEAD'), HEAD_REF('remounted'))
    assert.ok(await settled(() => missingShellLookups() > 0, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the changed HEAD must encounter the missing service before it returns')
    assert.equal(channel.gitBranch, 'main', 'a missing optional service must retain the previous branch')
    setShellAvailable(true)
    assert.ok(await settled(() => channel.gitBranch === 'remounted', { timeoutMs: DETECT_TIMEOUT_MS }),
      'a service remount must recover without another checkout')
  })

  const pendingMissingRepo = makeRepo()
  await scenario('a HEAD change without a shell invalidates a pending older reply', { cwd: pendingMissingRepo, branch: 'main' }, async ({ channel, answer, hold, gates, parkedReplies, setShellAvailable, missingShellLookups }) => {
    assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
    hold()
    answer('pending-a')
    writeFileSync(join(pendingMissingRepo, '.git', 'HEAD'), HEAD_REF('pending-a'))
    assert.ok(await settled(() => gates.length === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
    setShellAvailable(false)
    answer('current-b')
    writeFileSync(join(pendingMissingRepo, '.git', 'HEAD'), HEAD_REF('current-b'))
    assert.ok(await settled(() => missingShellLookups() > 0, { timeoutMs: DETECT_TIMEOUT_MS }),
      'the newer HEAD must encounter the absent service before the old reply lands')
    gates[0]()
    assert.ok(await settled(() => parkedReplies() === 1, { timeoutMs: DETECT_TIMEOUT_MS }))
    assert.equal(channel.gitBranch, 'main', 'a reply for A must not publish after the sampler has seen B')
    setShellAvailable(true)
    assert.ok(await settled(() => gates.length === 2, { timeoutMs: DETECT_TIMEOUT_MS }))
    gates[1]()
    assert.ok(await settled(() => channel.gitBranch === 'current-b', { timeoutMs: DETECT_TIMEOUT_MS }),
      'the service remount must still recover B without another HEAD change')
  })

  for (const metadata of ['HEAD', 'gitdir']) {
    const worktree = makeLinkedWorktree()
    await scenario(`an oversized ${metadata} file is not followed`, { cwd: worktree.cwd, branch: 'main' }, async ({ channel, answer, probes }) => {
      assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
      answer('over-budget')
      writeFileSync(join(worktree.gitdir, 'HEAD'), HEAD_REF('over-budget'))
      const path = metadata === 'HEAD' ? join(worktree.gitdir, 'HEAD') : join(worktree.cwd, '.git')
      const prefix = metadata === 'HEAD' ? HEAD_REF('over-budget') : `gitdir: ${worktree.gitdir.replaceAll('\\', '/')}\n`
      writeFileSync(path, prefix + ' '.repeat(128 * 1024))
      assert.ok(await settled(() => channel.gitBranch === undefined, { timeoutMs: DETECT_TIMEOUT_MS }),
        'an over-budget control file must become unreadable without publishing its parsed branch')
      assert.equal(probes.length, 1, 'oversized metadata must not trigger a shell query')
    })
  }

  if (process.platform === 'win32') {
    console.log('SKIP a FIFO HEAD does not park the periodic sampler: POSIX FIFO fixture')
  } else {
    const fifoRepo = makeRepo()
    await scenario('a FIFO HEAD does not park the periodic sampler', { cwd: fifoRepo, branch: 'main' }, async ({ channel }) => {
      assert.ok(await settled(() => channel.gitBranch === 'main', { timeoutMs: DETECT_TIMEOUT_MS }))
      const headPath = join(fifoRepo, '.git', 'HEAD')
      rmSync(headPath)
      execFileSync('mkfifo', [headPath])
      try {
        assert.ok(await settled(() => channel.gitBranch === undefined, { timeoutMs: DETECT_TIMEOUT_MS }),
          'a non-regular HEAD must be rejected before a blocking read')
      } finally {
        // Release an old implementation's blocked reader during the red run.
        // No reader is pending after the bounded implementation rejects it.
        let writer
        try {
          writer = openSync(headPath, constants.O_WRONLY | constants.O_NONBLOCK)
          writeSync(writer, HEAD_REF('main'))
        } catch (error) {
          if (error.code !== 'ENXIO') throw error
        } finally { if (writer !== undefined) closeSync(writer) }
      }
    })
  }
} finally {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}

assert.equal(unhandled.length, 0, 'async refresh work must handle its rejections')
const failed = results.filter(result => result.failure !== undefined)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  process.exitCode = 1
  console.log(`FAILED: ${failed.map(result => result.name).join(', ')}`)
}
