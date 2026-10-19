/**
 * Host seams every channel composition reads: the optional Cordis service
 * rows (themes, workspaces, command trees, scenes, settings sections,
 * custom-entry renderers), the default-deny decision gate with its
 * dispatch-topology marker, the runtime subscriptions that re-render on host
 * changes, and the git-branch breadcrumb. Each lookup degrades when its row
 * is not mounted, whatever backend serves the session.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AdapterRuntimeOptions } from '../../../adapter/kernel/runtime.js'
import { readGrantStore } from '../../../adapter/standard/grants.js'
import { getHostCommandTrees, type TuiCommandTreeRuntime } from '../../command-trees.js'
import { runForegroundShell, type ForegroundShell } from '../../compat/shell.js'
import { getHostGrantStore } from '../../host-grants.js'
import { getHostRenderers, type TuiRendererRuntime } from '../../renderers.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from '../../scenes.js'
import { getHostSettingsSections, type TuiSettingsSectionsRuntime } from '../../settings-sections.js'
import { getHostThemes, type TuiThemeRuntime } from '../../themes.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceRuntime } from '../../workspaces.js'
import type { ChannelHost, ServiceLookup } from '../channel-host.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState } from '../types.js'

/**
 * The host services a channel composition reads, looked up per read: the
 * profile's `tui*` rows can compose after the mount.
 */
export interface CoreHost {
  readonly adapterRuntime: AdapterRuntimeOptions
  readonly themeHost: ReturnType<typeof getHostThemes>
  /** Workspace registry runtime; the local-only runtime without the row. */
  readonly workspaceService: NonNullable<ReturnType<typeof getHostWorkspaceRuntime>> | ReturnType<typeof createLocalWorkspaceRuntime>
  readonly commandTrees: ReturnType<typeof getHostCommandTrees>
  readonly sceneRuntime: ReturnType<typeof getHostSceneRuntime>
  readonly settingsSectionsRuntime: ReturnType<typeof getHostSettingsSections>
  readonly rendererRuntime: ReturnType<typeof getHostRenderers>
  /** The live grant store: the host-owned one when the plugin-host row is
   *  mounted, else this channel's private fallback (re-read per operation). */
  currentGrantStore(): ReturnType<typeof readGrantStore>
}

/**
 * Resolve the host seams and install the decision gate. The topology marker
 * is effectful state, so it is owned at acquisition: a later construction
 * failure rolls it back.
 */
export function resolveCoreHost(ctx: ChannelHost, owner: Pick<ChannelOwner, 'own'>): CoreHost {
  const adapterRuntime = ctx.runtime
  // Backstop: the extensions row installs the decision-subscription gate,
  // but the channel is the dispatch path. A stale patch without that row (or
  // a bare embed mounting neither) would otherwise leave tui/input and
  // friends subscribable by default, silently voiding default-deny.
  // Idempotent per cordis root, so the full-patch path installs exactly
  // once whichever side runs first. Keep a private fallback for
  // bare embedders, but resolve the host-owned store on every operation so
  // a plugin-host row mounted later (or a custom live GrantStore) is not
  // shadowed by an early snapshot.
  const fallbackGrantStore = readGrantStore(undefined, undefined, adapterRuntime)
  const currentGrantStore = (): ReturnType<typeof readGrantStore> =>
    getHostGrantStore(ctx.get('tuiPluginHost')) ?? fallbackGrantStore
  ctx.installDecisionGuard(currentGrantStore())
  // The channel is the real DecisionEvents dispatch path. Record that
  // topology so the live driver can distinguish "guard installed" (not a
  // live feature) from "events can actually be dispatched here".
  owner.own(ctx.markDecisionDispatchTopology())
  // Workspace registry runtime (optional service, issue #183): mounted by
  // the bundle patch's dsh-tui-workspaces row; absent the row (stale patch
  // or a bare embedder), degrade to the local-only runtime (one per channel).
  let localWorkspaces: ReturnType<typeof createLocalWorkspaceRuntime> | undefined
  return {
    adapterRuntime,
    get themeHost() { return getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined) },
    get workspaceService() {
      return getHostWorkspaceRuntime(ctx.get('tuiWorkspaces') as TuiWorkspaceRuntime | undefined)
        ?? (localWorkspaces ??= createLocalWorkspaceRuntime())
    },
    get commandTrees() { return getHostCommandTrees(ctx.get('tuiCommandTrees') as TuiCommandTreeRuntime | undefined) },
    // Plugin scene runtime (optional, dsh-tui-scenes row): absent the row,
    // `pluginScene` simply stays undefined.
    get sceneRuntime() { return getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined) },
    // Falls back to the in-package local host when the composition's
    // service row is unavailable (issue #557).
    get settingsSectionsRuntime() {
      return getHostSettingsSections(ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined)
        ?? ctx.localSettingsSections()
    },
    // Custom-entry text renderers (optional, dsh-tui-extensions row): absent
    // the row, unknown plugin event types stay invisible in the transcript.
    get rendererRuntime() { return getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined) },
    currentGrantStore,
  }
}

/**
 * Re-render on settings-section and plugin-scene changes (owner-scoped),
 * re-binding when the host reports a service change.
 */
export function startHostSubscriptions(
  host: Pick<CoreHost, 'settingsSectionsRuntime' | 'sceneRuntime'>,
  owner: Pick<ChannelOwner, 'own' | 'current'>,
  state: Pick<ChannelState, 'pluginScene' | 'emit'>,
  services?: Pick<ChannelHost, 'watchServices'>,
): void {
  let sections: { runtime: CoreHost['settingsSectionsRuntime']; off: (() => void) | undefined } | undefined
  let scenes: { runtime: CoreHost['sceneRuntime']; off: (() => void) | undefined } | undefined
  const bind = (): boolean => {
    let changed = false
    const sectionsRuntime = host.settingsSectionsRuntime
    if (sections === undefined || sections.runtime !== sectionsRuntime) {
      sections?.off?.()
      sections = { runtime: sectionsRuntime, off: sectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) }
      changed = true
    }
    const sceneRuntime = host.sceneRuntime
    if (scenes === undefined || scenes.runtime !== sceneRuntime) {
      scenes?.off?.()
      scenes = {
        runtime: sceneRuntime,
        off: sceneRuntime?.subscribe(() => {
          if (state.pluginScene === sceneRuntime.active) return
          state.pluginScene = sceneRuntime.active
          state.emit()
        }),
      }
      if (state.pluginScene !== sceneRuntime?.active) state.pluginScene = sceneRuntime?.active
      changed = true
    }
    return changed
  }
  bind()
  owner.own(() => {
    sections?.off?.()
    scenes?.off?.()
    sections = undefined
    scenes = undefined
  })
  const unwatch = services?.watchServices?.(name => {
    if (name !== 'tuiSettingsSections' && name !== 'tuiScenes') return
    if (!owner.current()) return
    if (bind()) state.emit()
  })
  if (unwatch !== undefined) owner.own(unwatch)
}

/** How often the workspace HEAD is read for a signature change. */
const BRANCH_HEAD_POLL_MS = 1000
/** How far above the session cwd a repository root is looked for. */
const HEAD_SEARCH_DEPTH = 8

/**
 * The `HEAD` file of the repository containing `cwd`, or undefined when this
 * process cannot see one. A linked worktree (like a submodule) keeps its git
 * dir outside the worktree and records that indirection in `.git` as a
 * `gitdir:` line instead of a directory.
 *
 * Reached from the timer path, so it answers rather than throws: no checkout,
 * a malformed `.git` file and an unreadable directory all land on undefined and
 * leave the poll silent.
 */
function gitHeadPath(cwd: string): string | undefined {
  try {
    let dir = cwd
    for (let depth = 0; depth < HEAD_SEARCH_DEPTH; depth += 1) {
      const dotGit = join(dir, '.git')
      // The no-entry form keeps the common "not below a repository" walk out
      // of the exception path; only an unexpected filesystem error is caught.
      const entry = statSync(dotGit, { throwIfNoEntry: false })
      if (entry?.isDirectory()) return join(dotGit, 'HEAD')
      if (entry?.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
        // A relative target resolves against the directory holding the `.git`
        // file, which is the base git itself records it against.
        if (target === undefined) return undefined
        return join(resolve(dirname(dotGit), target.trim()), 'HEAD')
      }
      if (entry !== undefined) return undefined
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The HEAD text a probe is anchored on; undefined when there is nothing to read. */
function readHeadSignature(headPath: string | undefined): string | undefined {
  if (headPath === undefined) return undefined
  try {
    return readFileSync(headPath, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Statusline breadcrumb: the current git branch of the session cwd
 * (best-effort, through the host `shell` service). Re-run when an adoption
 * lands on a different cwd (/resume, /workspace, issue #96) so the
 * breadcrumb never shows the previous workspace's branch.
 *
 * Adoption is not the only way the branch changes: a `git checkout` in
 * another terminal leaves this process nothing to observe otherwise, so the
 * refresher also follows the workspace's own `.git/HEAD` and re-probes when
 * its content changes. Polling, not `fs.watch`, for the reason the grant
 * store already documents: a watcher can keep following a replaced inode,
 * and `gitdir:` indirection, network mounts and watch limits each need their
 * own fallback. The signature is the file's text, not its mtime: timestamp
 * granularity is coarse and differs per filesystem, while HEAD is well under
 * 100 bytes and says exactly what a checkout changed.
 *
 * Where the host shell runs somewhere else (remote or sandboxed workspace),
 * this process's `.git` is not the workspace's: without a HEAD to anchor on
 * the poll stays quiet and the breadcrumb keeps whatever the shell last
 * reported, rather than clearing a value it cannot verify.
 */
export function createGitBranchRefresher(ctx: ServiceLookup, deps: {
  owner: Pick<ChannelOwner, 'current' | 'own'>
  state: Pick<ChannelState, 'cwd' | 'gitBranch' | 'emit'>
  /** Record the resolved branch against the bound session (the session
   *  browser's branch column); absent = nothing records it. */
  noteBranch?(branch: string): void
}): () => void {
  const { state } = deps
  /** The cached resolution, so only a workspace switch re-walks to the repo. */
  let headCwd: string | undefined
  let headPath: string | undefined
  /** The HEAD text the last probe was issued against. */
  let signature: string | undefined
  /** Tickets handed out to probes; only the newest holder may publish. */
  let issued = 0

  const resolveHead = (): string | undefined => {
    const cwd = state.cwd
    if (cwd === headCwd) return headPath
    headCwd = cwd
    headPath = gitHeadPath(cwd)
    // Another workspace has no signature here yet, so its next tick probes.
    signature = undefined
    return headPath
  }

  const probe = (clearFirst: boolean): void => {
    // The adoption path clears first so a switch never shows the previous
    // workspace's branch. A poll does not: the value still belongs to this
    // workspace, and blanking it across the round trip would paint a gap on
    // the next unrelated redraw.
    if (clearFirst) state.gitBranch = undefined
    // Baseline taken when the probe is issued: a checkout landing while the
    // shell runs then still differs from this text and triggers the next
    // tick instead of hiding behind a signature already consumed.
    signature = readHeadSignature(resolveHead())
    const shell = ctx.get('shell') as ForegroundShell | undefined
    if (!shell) return
    // Capture the requested cwd: a /resume landing while this query is in
    // flight refreshes the branch for the new cwd, so a late reply from the
    // old workspace must be dropped (stale statusline, issue #96).
    const requestedCwd = state.cwd
    // Two probes can be in flight at once (the shell does not serialize them),
    // so each takes a ticket and only the newest one speaks for the workspace.
    const ticket = ++issued
    void runForegroundShell(shell, {
      command: 'git branch --show-current',
      workdir: requestedCwd,
      timeoutMs: 3000,
    })
      .then((result) => {
        // The newer probe already speaks for the workspace and its baseline
        // matches the current HEAD, so nothing would re-probe after this
        // reply: a slower older one would pin a branch no longer checked out.
        if (ticket !== issued) return
        // A timed-out probe reports whatever it managed to capture, often
        // nothing. That is not "no branch": clearing on it would blank the
        // breadcrumb while the consumed signature keeps the next tick quiet.
        if (result.timedOut) return
        if (!deps.owner.current() || state.cwd !== requestedCwd) return
        const branch = result.stdout.text.trim()
        // A detached HEAD (or a cwd outside any repository) answers nothing:
        // clear it instead of keeping a branch that is no longer checked out,
        // which is also what a cold start would show.
        const next = branch === '' ? undefined : branch
        if (next === state.gitBranch) return
        state.gitBranch = next
        // The session index records branches, never the absence of one.
        if (next !== undefined) deps.noteBranch?.(next)
        state.emit()
      })
      .catch(() => {
        // Git branch detection is best-effort; on Windows the sandbox
        // backend may be unavailable (no confinement yet) or the cwd may
        // not be a git repo. Either way the statusline simply stays blank.
      })
  }

  const timer = setInterval(() => {
    if (!deps.owner.current()) return
    const next = readHeadSignature(resolveHead())
    if (next === undefined || next === signature) return
    probe(false)
  }, BRANCH_HEAD_POLL_MS)
  timer.unref?.()
  deps.owner.own(() => clearInterval(timer))

  return () => { probe(true) }
}
