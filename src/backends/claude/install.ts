/**
 * One-shot installer for the optional `@anthropic-ai/claude-agent-sdk` peer.
 *
 * Runs `pnpm add <sdk>@<pin>` in the DSH profile root — the install dir whose
 * `node_modules` the backend's dynamic import resolves through. Everything the
 * child prints is piped and captured, never inherited: an inherit-stdio child
 * may only run after the Ink frame is unmounted (the update.ts contract); a
 * captured one may run under the live TUI, which is what the kernel-picker
 * install wizard needs. Only the tail of the captured output is surfaced, on
 * failure.
 *
 * The pinned SDK version is old enough that pnpm's minimumReleaseAge gate
 * never blocks it; if the pin ever moves to a version published within the
 * gate's window, the install needs a `minimumReleaseAgeExclude` entry
 * (generalize `ensureProfileReleaseAgeExclude` in update.ts then).
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'
import type { SdkInstallResult, SdkInstallTarget, SdkInstaller } from '../../agent/backend.js'
import { ensureWorkspaceAllowBuilds, ensureWorkspaceStoreDir, isStandaloneRuntime, profileWorkspaceYamlPath, resolveDshProfileName } from '../../update.js'
import { shellQuote } from '../../utils/shellQuote.js'
import { CLAUDE_SDK_SPECIFIER } from './contract.js'

export type { SdkInstallTarget, SdkInstallResult, SdkInstaller } from '../../agent/backend.js'

/** Resolve the install target for the CURRENT launch (never throws). The
 *  non-profile kinds carry the reason for the wizard's manual-instructions
 *  panel: standalone builds swap a whole binary (update.ts owns that path),
 *  and source checkouts / `--config` launches have no profile to add into. */
export function resolveSdkInstallTarget(argv: readonly string[] = process.argv): SdkInstallTarget {
  if (isStandaloneRuntime()) return { kind: 'standalone' }
  const profile = resolveDshProfileName(argv)
  return profile === undefined ? { kind: 'no-profile' } : { kind: 'profile', dir: dirname(profileWorkspaceYamlPath(profile)) }
}

interface CapturedRun {
  readonly code: number | undefined
  /** The spawn `error.code` (e.g. 'ENOENT' when pnpm is not on PATH). */
  readonly spawnError?: string
  readonly lines: readonly string[]
}

/** Run pnpm with captured output. On Windows the arguments fold into the
 *  command string and go through the shell — pnpm is a `.cmd` shim there and
 *  Node ≥22 refuses to spawn `.cmd` directly (DEP0190) — the same escape
 *  update.ts's runProcess uses. */
function runPnpm(args: readonly string[], cwd: string): { readonly promise: Promise<CapturedRun>; readonly cancel: () => void } {
  const windows = process.platform === 'win32'
  const [command, spawnArgs]: [string, string[]] = windows
    ? [`pnpm ${shellQuote(args).join(' ')}`, []]
    : ['pnpm', [...args]]
  const child = spawn(command, spawnArgs, {
    cwd,
    shell: windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { chunks.push(chunk) })
  }
  const promise = new Promise<CapturedRun>(resolve => {
    const finish = (code: number | undefined, spawnError?: string): void => {
      // pnpm progress frames redraw with \r — split on all line breaks, strip
      // the ANSI layer, drop the empty frames the redraws leave behind.
      const lines = chunks.join('').split(/\r\n|\r|\n/u).map(line => stripAnsi(line).trim()).filter(line => line !== '')
      resolve({ code, spawnError, lines })
    }
    child.once('error', error => finish(undefined, (error as NodeJS.ErrnoException).code))
    child.once('close', code => finish(code ?? undefined))
  })
  return { promise, cancel: () => { child.kill() } }
}

/** Whether `pnpm` runs at all (the wizard's preflight). */
export async function checkPnpmAvailable(): Promise<boolean> {
  const { promise } = runPnpm(['--version'], homedir())
  const run = await promise
  return run.code === 0 && run.spawnError === undefined
}

/** pnpm's store-mismatch diagnostic line: the profile's node_modules was
 *  built against a store pnpm no longer resolves (environment-drifted
 *  \u0060XDG_DATA_HOME\u0060, a changed global store config). Rebuild-healable. */
const UNEXPECTED_STORE = /ERR_PNPM_UNEXPECTED_STORE/u

function isStoreMismatch(run: CapturedRun): boolean {
  return run.code !== 0 && run.spawnError === undefined
    && run.lines.some(line => UNEXPECTED_STORE.test(line))
}

/** Install the pinned SDK into the profile root. Resolve target failures are
 *  the caller\u0027s business (the wizard shows manual instructions for them).
 *
 *  Store drift heals itself: the workspace file is pinned to a stable
 *  \u0060storeDir\u0060 first (see \u0060ensureWorkspaceStoreDir\u0060), and when pnpm still
 *  reports \u0060ERR_PNPM_UNEXPECTED_STORE\u0060 — drift that predates the pin, or the
 *  pin itself landing on an existing node_modules — node_modules is removed,
 *  rebuilt from the lockfile under the pinned store, and the add retried,
 *  all inside this one result. A live TUI may be running from that
 *  node_modules: open inodes keep it alive on Linux/macOS, and the window
 *  matches what a manual rebuild already does today. */
export function startClaudeSdkInstall(dir: string): SdkInstaller {
  let cancelled = false
  let active: Readonly<{ cancel: () => void }> | undefined
  const run = (args: readonly string[]): Promise<CapturedRun> => {
    const current = runPnpm(args, dir)
    active = current
    return current.promise
  }
  const result = (async (): Promise<SdkInstallResult> => {
    // Seed before any pnpm run: the store pin (drift prevention — a pin
    // landing after node_modules exists is itself a store change, and the
    // heal below covers pre-existing drift and that induced one in the same
    // pass) and the build-script opt-outs a full lockfile rebuild needs on
    // pnpm ≥11 (ERR_PNPM_IGNORED_BUILDS, see ensureProfileAllowBuilds).
    const yamlPath = join(dir, 'pnpm-workspace.yaml')
    ensureWorkspaceStoreDir(yamlPath)
    ensureWorkspaceAllowBuilds(yamlPath)
    const first = await run(['add', CLAUDE_SDK_SPECIFIER])
    if (cancelled) return { kind: 'cancelled' }
    if (first.code === 0) return { kind: 'ok' }
    if (first.spawnError === 'ENOENT') return { kind: 'pnpm-missing' }
    if (!isStoreMismatch(first)) {
      return { kind: 'failed', exitCode: first.code ?? 1, tail: first.lines.slice(-10) }
    }
    try {
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      return { kind: 'failed', exitCode: first.code ?? 1, tail: first.lines.slice(-10) }
    }
    const rebuild = await run(['install'])
    if (cancelled) return { kind: 'cancelled' }
    if (rebuild.code !== 0) {
      return { kind: 'failed', exitCode: rebuild.code ?? 1, tail: rebuild.lines.slice(-10) }
    }
    const retry = await run(['add', CLAUDE_SDK_SPECIFIER])
    if (cancelled) return { kind: 'cancelled' }
    if (retry.code === 0) return { kind: 'ok', rebuiltStore: true }
    if (retry.spawnError === 'ENOENT') return { kind: 'pnpm-missing' }
    return { kind: 'failed', exitCode: retry.code ?? 1, tail: retry.lines.slice(-10) }
  })()
  return { result, cancel: () => { cancelled = true; active?.cancel() } }
}
