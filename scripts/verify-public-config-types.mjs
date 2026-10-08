/**
 * 包入口的配置面类型回归（review R1）：`Config.backend` 必须继续接受**普通字符串**。
 *
 * 背景：#1380 曾把 `Config.backend` 声明成 branded 的 `KernelBackendId`
 * （`string & { readonly [validatedBackendId]: true }`，brand 用的是包内未导出的
 * `unique symbol`）。`Config` 经 `src/index.ts` 的 `export *` 就在已发布入口上，于是
 * 消费者原先合法的 `{ backend: 'codex' }` 变成 TS2322——连 `'dsh'` / `'claude'` 也编译
 * 不过。品牌本身没错，它是用来挡住**未校验**的字符串进入 session ref 与
 * `~/.dsh-tui/backends/<id>/` 路径的；错的是把它放在了**输入**面上。
 *
 * 做法：把消费者写法写成真实文件，交给仓库自己的 tsc 编译
 * （`lib/types/index.d.ts` = `main`/`types` 指向的已发布声明，所以要先 build）。
 * 两个方向都能红，判据只有一句「零诊断」：
 *   - 品牌回归 → 正例上出现 TS2322；
 *   - 类型被放宽成 any / unknown → `@ts-expect-error` 变成 unused directive。
 *
 * Run: node scripts/verify-public-config-types.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const workDir = join(root, 'node_modules', '.cache', 'dsh-tui', 'public-config-types')
// `main`/`types` 指向的已发布声明；相对路径按 workDir 的深度算好（四层回到仓库根）。
const entry = '../../../../lib/types/index.js'
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const fixture = `import type { Config } from '${entry}'

// 既有的配置写法必须继续编译：内置后端是普通字符串字面量。
export const dsh: Config = { backend: 'dsh' }
export const claude: Config = { backend: 'claude' }
export const codex: Config = { backend: 'codex' }
// 插件后端的 id 同样是普通字符串：它在 schema 与 boot 两处过门，不靠类型挡。
export const plugin: Config = { backend: 'acme-agent' }
// 上面几条要是被 brand 挡住就会报 TS2322；反过来，类型也不能松成 any——
// 非字符串必须仍然被拒（松掉时 @ts-expect-error 会变成 unused directive）。
// @ts-expect-error backend is a string, never a number
export const bad: Config = { backend: 42 }
`

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
writeFileSync(join(workDir, 'public-config.ts'), fixture, 'utf8')
writeFileSync(join(workDir, 'tsconfig.json'), `${JSON.stringify({
  compilerOptions: {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: 'es2024',
    module: 'esnext',
    moduleResolution: 'bundler',
    // 空 types：这面只测声明形状，不拉 @types/node（包入口的 d.ts 由 skipLibCheck 兜住）。
    types: [],
  },
  files: ['public-config.ts'],
}, null, 2)}\n`, 'utf8')

// `--listFiles` 让"真的检查了这个文件"可证：只看"没有诊断"是不设防的——tsc 没起来、
// 或者 program 里根本没这个文件，同样一声不吭，测试便空转通过。
const run = spawnSync(process.execPath, [tsc, '-p', join(workDir, 'tsconfig.json'), '--listFiles'], { encoding: 'utf8' })
if (run.error !== undefined) {
  console.error(`could not run tsc (${tsc}): ${run.error.message}`)
  process.exit(1)
}
const stdout = run.stdout ?? ''
if (run.status !== 0) {
  console.error('The published Config surface no longer accepts plain backend ids (review R1):')
  console.error(`${stdout}${run.stderr ?? ''}`.trim())
  process.exit(1)
}
if (!stdout.includes('public-config.ts')) {
  console.error('tsc exited 0 but never checked the fixture — the check would pass for any shape:')
  console.error(stdout.trim())
  process.exit(1)
}
console.log('PASS: Config.backend accepts dsh / claude / codex / a plugin id, and still rejects a non-string')
console.log('\nverify-public-config-types OK (1 check)')
process.exit(0)
