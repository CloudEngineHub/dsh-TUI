/**
 * The runtime backend registry (roadmap Stage A / P0).
 *
 * Before this module, "which backends exist" was a hand-written closed set
 * spread over `kernelPrefs.ts`, this adapter, the launcher copy and the boundary
 * gate: every new backend had to be copied into all of them (codex did exactly
 * that, #1352). Now the set is the built-in seed plus whatever the build-time
 * index found under `src/backends/*​/manifest.ts` — adding a backend is a new
 * directory, nothing else.
 *
 * Three properties this file must keep (they are what a fourth backend would
 * otherwise break):
 *
 *  - **Lazy**: an entry that is never loaded is never imported. `probeKernels`
 *    is the only path that loads everything, and it is opt-in.
 *  - **Booked pooling** (D4): `unloadExport` is remembered when — and only when —
 *    the entry's module was actually imported, so a DSH-only boot does not pay a
 *    module import (let alone a child process) just to close a pool it never
 *    opened. The one exit funnel (`plugin.ts`'s `disposeRootAndThen`) calls
 *    {@link unloadBackends} after the fiber is disposed and stays otherwise
 *    untouched.
 *  - **Membership is the second half of the parse** (D1): a syntactically valid
 *    but unregistered id must behave exactly like an unknown value everywhere
 *    (dsh + a warning, never a crashed boot). See {@link parseBackendChoice}.
 */
import type { AgentBackend } from '../agent/backend.js'
import { isBackendIdSyntax, type BackendEntry, type BackendManifest } from '../agent/backend-manifest.js'
import { cleanRenderText } from '../channel/sanitize.js'
import { BUILTIN_BACKEND_IDS, type KernelBackendId } from '../kernelPrefs.js'
import { logForDebugging } from '../utils/debug.js'
import { GENERATED_BACKENDS } from './backends.generated.js'

export { isBackendIdSyntax }

/**
 * The DSH kernel. In-tree and always available, but **not** an `AgentBackend`:
 * its session is built by `createDshSession()` from the DSH agent, and P0 does
 * not force it into the backend contract just for symmetry (roadmap §7.3).
 * Seeded first, so the picker order stays `dsh, claude, codex, …`.
 */
const DSH_MANIFEST: BackendManifest = {
  id: 'dsh',
  label: { kind: 'key', key: 'kernel-label-dsh' },
  shortLabel: 'DSH',
  product: 'dsh-core',
  inTree: true,
  alwaysAvailable: true,
  installable: false,
}

/**
 * The one backend whose SDK install this host actually implements:
 * `sdkInstallSurface()` (`backends.ts`) statically wires Claude's installer and
 * nothing else, and the `sdk-install` overlay carries no backend id at all — it
 * could not install anything else even if it wanted to.
 *
 * That makes `installable` / `sdkInstall` an **exclusive** privilege rather than
 * free-form manifest data, in the same family as `nativeKey` (refused outright off
 * the tree). Stage A opens the backend set to plugins and to a fourth in-tree
 * backend; without the gate below, any of them could turn its own dim row into a
 * one-Enter path into *Claude's* wizard — a row wearing one name while installing
 * another program. Stage B gives each backend its own host-side installer and this
 * check becomes "does this id have an install surface", which is why it is stated
 * as a single id rather than a flag.
 *
 * Kept local on purpose: the registry must not import a concrete backend (they
 * enter only through the lazy `load()`), and the value is self-checking anyway —
 * the real Claude manifest declares exactly this privilege at module load, so a
 * wrong constant makes this module fail to import.
 */
const HOST_INSTALLABLE_BACKEND_ID = 'claude'

/**
 * One registered backend: the manifest, its id as a validated {@link KernelBackendId}
 * (the cast below is reached only after the syntax gate), and the lazy loader.
 * Everything downstream — picker rows, session refs, `~/.dsh-tui/backends/<id>/`
 * paths — takes the id from here instead of re-validating it.
 */
export interface RegisteredBackend {
  readonly id: KernelBackendId
  readonly manifest: BackendManifest
  readonly load?: () => Promise<Record<string, unknown>>
}

/** Registration order = picker order (`listBackends`). */
const entries = new Map<string, RegisteredBackend>()

/**
 * Cell budget for a plugin-declared name. The picker pane is at most ~72 cells
 * wide and the launchpad plate far narrower, so this only bounds what a
 * misbehaving manifest can put on the render path (and in the notices written to
 * stdout) — layout truncation stays the renderer's job.
 */
const LABEL_MAX_CELLS = 48

/** Close hooks of the entries whose module was actually imported (D4). */
const loadedUnloads = new Map<string, () => Promise<void>>()

/**
 * Add one entry. The built-in seeds register themselves below; the plugin
 * discovery of Stage C is the intended second caller, which is why the checks
 * are loud rather than lenient: a bad manifest must fail at registration, not
 * paint a wrong row.
 */
export function registerBackend(entry: BackendEntry): void {
  const { manifest } = entry
  const where = `dsh-tui: backend "${manifest.id}"`
  if (!isBackendIdSyntax(manifest.id)) {
    throw new Error(`${where} has an invalid id (lowercase letters, digits and dashes, at most 32 characters)`)
  }
  if (entries.has(manifest.id)) throw new Error(`${where} is already registered`)
  if (!manifest.inTree && (BUILTIN_BACKEND_IDS as readonly string[]).includes(manifest.id)) {
    // `dsh` refs serialize without a prefix (`formatSessionRef`), so a plugin
    // wearing that id would collide with first-party references.
    throw new Error(`${where} is a reserved built-in id`)
  }
  if (!manifest.inTree && manifest.label.kind === 'key') {
    // Otherwise a plugin could claim a first-party name: `t()` returns the text
    // of an existing key (`src/i18n.ts`), so the row would read "DeepSeek Harness".
    throw new Error(`${where} is not in-tree and may not use a host label key; declare { kind: 'literal', text }`)
  }
  if (!manifest.inTree && manifest.alwaysAvailable === true) {
    throw new Error(`${where} is not in-tree and may not be always-available`)
  }
  if (!manifest.inTree && manifest.nativeKey !== undefined) {
    throw new Error(`${where} is not in-tree and may not declare a native channel`)
  }
  if (manifest.alwaysAvailable === true && entry.load !== undefined) {
    throw new Error(`${where} is always-available and must not have a loader (it is not an AgentBackend)`)
  }
  if ((manifest.installable === true) !== (manifest.sdkInstall !== undefined)) {
    throw new Error(`${where} must declare installable exactly when it declares sdkInstall`)
  }
  if (manifest.id !== HOST_INSTALLABLE_BACKEND_ID
    && (manifest.installable === true || manifest.sdkInstall !== undefined)) {
    throw new Error(`${where} declares installable/sdkInstall, but this host ships exactly one install wizard (${HOST_INSTALLABLE_BACKEND_ID}); a backend brings its own in Stage B`)
  }
  // Plugin-declared names are external input: flatten control/escape sequences
  // and cap the width here, once, so the picker, the launchpad plate and the
  // handoff notices all render the same sanitized text (in-tree names are this
  // package's own strings and stay verbatim; `label.key` must stay a raw key).
  const registered: RegisteredBackend = {
    // The one place that may mint a KernelBackendId: the syntax gate above has
    // already run, and membership is this very map.
    id: manifest.id as KernelBackendId,
    manifest: manifest.inTree ? manifest : {
      ...manifest,
      label: manifest.label.kind === 'literal' ? { kind: 'literal', text: cleanRenderText(manifest.label.text, LABEL_MAX_CELLS) } : manifest.label,
      shortLabel: cleanRenderText(manifest.shortLabel, LABEL_MAX_CELLS),
    },
    ...(entry.load === undefined ? {} : { load: entry.load }),
  }
  entries.set(manifest.id, registered)
}

// The built-in seed: dsh first, then the generated index in directory-name
// order (claude, codex, …).
registerBackend({ manifest: DSH_MANIFEST })
for (const entry of GENERATED_BACKENDS) registerBackend(entry)

/** Every registered backend, in declaration order (= picker order). */
export function listBackends(): readonly RegisteredBackend[] {
  return [...entries.values()]
}

/** One backend, or undefined when no such backend is registered. */
export function getBackend(id: string): RegisteredBackend | undefined {
  return entries.get(id)
}

/** Whether an untrusted value names a backend this process can actually run.
 *  This is the second half of the parse (D1) and the only way to obtain a
 *  {@link KernelBackendId} outside `kernelPrefs`' own syntax gate. */
export function isRegisteredBackend(value: unknown): value is KernelBackendId {
  return isBackendIdSyntax(value) && entries.has(value)
}

/**
 * The backend a configured / remembered value names: trimmed, lowercased, and
 * **registered**. Anything else is undefined, which every caller already treats
 * as "no choice made" (dsh + a warning) — the semantics an unknown value had
 * before the set was open (D1).
 */
export function parseBackendChoice(value: unknown): KernelBackendId | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return isRegisteredBackend(id) ? id : undefined
}

/** The display name of a backend id: its manifest's short brand name, else the
 *  id itself (a session from an uninstalled plugin must still render as
 *  something). */
export function backendLabel(id: string): string {
  return getBackend(id)?.manifest.shortLabel ?? id
}

/**
 * Import one registered backend's implementation and book its pool hook.
 *
 * The two failure messages stay distinct (D1): "not registered" means the id was
 * never a choice, "has no loader" means the id names the host's own kernel.
 */
export async function loadBackend(id: KernelBackendId): Promise<AgentBackend> {
  const entry: RegisteredBackend | undefined = entries.get(id)
  if (entry === undefined) throw new Error(`dsh-tui: backend "${id}" is not registered`)
  if (entry.load === undefined) throw new Error(`dsh-tui: backend "${id}" has no loader (only the DSH kernel is not an AgentBackend)`)
  const module = await entry.load()
  const { backendExport, unloadExport } = entry.manifest
  if (unloadExport !== undefined) {
    const unload = module[unloadExport]
    if (typeof unload !== 'function') {
      throw new Error(`dsh-tui: backend "${id}" declares unloadExport "${unloadExport}", but its module does not export it`)
    }
    // Overwriting is fine: the same module instance hands back the same hook.
    loadedUnloads.set(id, unload as () => Promise<void>)
  }
  const exportName = backendExport ?? 'backend'
  const backend = module[exportName]
  if (backend === undefined) throw new Error(`dsh-tui: backend "${id}" does not export "${exportName}"`)
  return backend as AgentBackend
}

/**
 * Close the pooled, process-wide resources of every backend this process
 * actually loaded, in load order, then forget them (idempotent).
 *
 * Called once from the exit funnel *after* `ctx.root.fiber.dispose()`: closing a
 * pool first would break the in-flight sessions whose calls still hold it
 * (D4-P3). A failing or hanging hook must not block the exit — failures only
 * reach the debug log, and a stuck one is caught by the funnel's existing 5s
 * bound (P4).
 */
export async function unloadBackends(): Promise<void> {
  for (const [id, unload] of loadedUnloads) {
    try {
      await unload()
    } catch (error) {
      logForDebugging(`dsh-tui: backend "${id}" unload failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  loadedUnloads.clear()
}
