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
 * The `HEAD` file of the repository containing `cwd` (a linked worktree or a
 * submodule points at its git dir through a `gitdir:` line in `.git`), or
 * undefined when this process cannot see one. Reached from the timer path, so
 * it answers rather than throws: a missing or malformed `.git` lands on
 * undefined and leaves the poll silent.
 */
function gitHeadPath(cwd: string): string | undefined {
  try {
    let dir = cwd
    for (let depth = 0; depth < HEAD_SEARCH_DEPTH; depth += 1) {
      const dotGit = join(dir, '.git')
      // Keeps the common "not in a repository" walk out of the exception path;
      // only a real filesystem error is caught.
      const entry = statSync(dotGit, { throwIfNoEntry: false })
      if (entry?.isDirectory()) return join(dotGit, 'HEAD')
      if (entry?.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
        // Git records the target relative to the directory holding `.git`.
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
 * Adoption is not the only way the branch changes: a checkout in another
 * terminal has to be seen through the workspace's own `.git/HEAD`, whose text
 * is re-probed when it changes. Polling rather than `fs.watch` follows the
 * grant store (a watcher can outlive a replaced inode, and `gitdir:`
 * indirection, network mounts and watch limits each need their own fallback);
 * the text is the signature, not the mtime, because timestamp granularity
 * differs per filesystem while HEAD is well under 100 bytes.
 *
 * Where the host shell runs elsewhere (remote or sandboxed workspace), this
 * process's `.git` is not the workspace's: with no HEAD to anchor on the poll
 * stays quiet instead of clearing a value it cannot verify.
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
    // Adoption clears first so a switch never shows the previous workspace's
    // branch; a poll keeps the value, so an unrelated redraw during the round
    // trip cannot paint a gap.
    if (clearFirst) state.gitBranch = undefined
    // Baseline at issue time: a checkout landing while the shell runs still
    // differs from it and triggers the next tick.
    signature = readHeadSignature(resolveHead())
    const shell = ctx.get('shell') as ForegroundShell | undefined
    if (!shell) return
    // Capture the requested cwd: a /resume landing while this query is in
    // flight refreshes the branch for the new cwd, so a late reply from the
    // old workspace must be dropped (stale statusline, issue #96).
    const requestedCwd = state.cwd
    // Two probes can be in flight (the shell does not serialize them); only
    // the newest one speaks for the workspace.
    const ticket = ++issued
    void runForegroundShell(shell, {
      command: 'git branch --show-current',
      workdir: requestedCwd,
      timeoutMs: 3000,
    })
      .then((result) => {
        // A newer probe already speaks for the workspace and its baseline
        // matches HEAD, so nothing would re-probe after this slower reply.
        if (ticket !== issued) return
        // A timed-out probe reports whatever it captured, often nothing: that
        // is not "no branch", and the consumed signature would keep us quiet.
        if (result.timedOut) return
        if (!deps.owner.current() || state.cwd !== requestedCwd) return
        const branch = result.stdout.text.trim()
        // A detached HEAD (or a cwd outside any repository) answers nothing:
        // clear it, which is also what a cold start would show.
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
    if (next === undefined) {
      // The HEAD this process was following is gone (repository removed, .git
      // unreadable), so stop claiming a branch it can no longer verify. A
      // workspace whose HEAD was never readable stays quiet instead: that is
      // the remote or sandboxed case, where the shell is the only authority.
      if (signature === undefined) return
      signature = undefined
      if (state.gitBranch === undefined) return
      state.gitBranch = undefined
      state.emit()
      return
    }
    if (next === signature) return
    probe(false)
  }, BRANCH_HEAD_POLL_MS)
  timer.unref?.()
  deps.owner.own(() => clearInterval(timer))

  return () => { probe(true) }
}
