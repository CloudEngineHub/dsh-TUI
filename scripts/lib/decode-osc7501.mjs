/**
 * decode-osc7501 — OSC 7501（Program Status Protocol）报告的解码核心。
 *
 * 被 scripts/decode-osc7501.mjs（取证 CLI）与它的回归共用。
 *
 * **这里的每一个字节都是不可信输入。** 日志、stdin 甚至别的进程的抓包都可以
 * 塞进任意内容，而规范明确要求：解码后的 `msg`/`title` 含控制字符的报告整条
 * 丢弃（否则光是「看一眼日志」就能执行 OSC 52、清屏一类终端控制序列）。因此
 * 本模块的输出契约是硬性的——**没有任何来自报告的字节会未经转义进入输出**：
 *
 *   - `title`/`msg` 先按规范校验：base64 解不出、或解出来含 C0/DEL/C1，整条
 *     拒绝（`ok: false`），绝不展示解码结果；
 *   - 其余不可信字段（`state`、`app`、`id`、未知键、探测文本）统一经
 *     `escapeForDisplay()` 转成可见转义再展示。
 */

import { Buffer, isUtf8 } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

/** 报告起始：`ESC ] 7501 ;`。 */
export const REPORT_PREFIX = '\x1b]7501;'

/** 一条报告的完整序列上限（规范 Limits 表：4096 字节）。 */
export const MAX_SEQUENCE_BYTES = 4096

/** C0、DEL、C1 —— 规范禁止出现在解码后 `msg`/`title` 里的字符。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u

const STATE_GLYPH = {
  idle: '○',
  working: '◐',
  blocked: '◼',
  done: '●',
  error: '✗',
  clear: '⌫',
}

const KNOWN_KEYS = ['state', 'kind', 'progress', 'app', 'id', 'title', 'msg']

/** 常见控制字符的可见写法；其余落在 `\xNN`。 */
const NAMED_ESCAPES = new Map([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x1b, '\\e'],
])

/** 解码后的 `msg`/`title` 是否含控制字符（规范要求整条拒绝）。 */
export function hasControlChar(text) {
  return CONTROL_RE.test(text)
}

/**
 * 把不可信文本转成「只含可见字符」的一行：控制字符写成 `\e`/`\n`/`\xNN`，格式符与行/段分隔符写成 `\u{…}`，
 * 其余原样。这是本模块唯一的输出通道，任何来自报告的字段都必须先过这里。
 */
export function escapeForDisplay(text) {
  let out = ''
  for (const char of text.replace(/[\p{Cf}\u2028\u2029]/gu, char => `\\u{${char.codePointAt(0).toString(16)}}`)) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
      out += char
      continue
    }
    out += NAMED_ESCAPES.get(code) ?? `\\x${code.toString(16).padStart(2, '0')}`
  }
  return out
}

/**
 * 规范的 base64（UTF-8 文本，padding 可省）。解不出返回 `null`：字符集不合法、
 * 长度/padding 不符、非零 pad bits、或字节不是合法 UTF-8。直接校验字节，不能把合法的 U+FFFD
 * 误当成解码失败。空串解出空串。
 */
export function decodeBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null
  const body = text.replace(/=+$/u, '')
  if (body.length % 4 === 1 || (body !== text && text.length % 4 !== 0)) return null
  const decoded = Buffer.from(body, 'base64')
  if (decoded.toString('base64').replace(/=+$/u, '') !== body) return null
  return isUtf8(decoded) ? decoded.toString('utf8') : null
}

/** 保留有序键值对，先逐项校验上限，再应用重复键的最后值。 */
export function parsePairs(body) {
  const out = []
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    out.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()])
  }
  return out
}

/**
 * 解释一条报告 body。
 *
 * `ok: false` 表示**整条按规范丢弃**（解码后含控制字符 / base64 不合法），
 * 此时只回报原因和一个转义过的 proof，绝不回报解码结果。
 */
export function interpretReport(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('?')) {
    return { ok: true, line: `探测回复/查询：${escapeForDisplay(trimmed)}` }
  }
  const entries = parsePairs(body)
  const decoded = {}
  for (const [key, raw] of entries) {
    const segments = key === 'id' ? raw.split('/') : []
    if (Buffer.byteLength(key) > 16
      || (key === 'app' && Buffer.byteLength(raw) > 32)
      || (key === 'id' && (Buffer.byteLength(raw) > 128 || segments.length > 8
        || segments.some(segment => Buffer.byteLength(segment) > 32)))) {
      return { ok: false, reason: '字段超过协议上限', detail: escapeForDisplay(key) }
    }
    if (key !== 'title' && key !== 'msg') continue
    if (raw === '') {
      delete decoded[key]
      continue
    }
    const [encodedLimit, decodedLimit] = key === 'title' ? [256, 192] : [2732, 2048]
    if (Buffer.byteLength(raw) > encodedLimit) {
      return { ok: false, reason: `${key} 超过编码字节上限`, detail: `${Buffer.byteLength(raw)} > ${encodedLimit}` }
    }
    const text = decodeBase64(raw)
    if (text === null) {
      return { ok: false, reason: `${key} 不是合法 base64`, detail: escapeForDisplay(raw) }
    }
    if (hasControlChar(text)) {
      return { ok: false, reason: `解码后的 ${key} 含控制字符`, detail: escapeForDisplay(raw) }
    }
    if (Buffer.byteLength(text) > decodedLimit) {
      return { ok: false, reason: `${key} 超过解码字节上限`, detail: `${Buffer.byteLength(text)} > ${decodedLimit}` }
    }
    decoded[key] = text
  }

  const pairs = Object.fromEntries(entries)
  const state = pairs.state ?? '(缺 state)'
  const bits = [`${STATE_GLYPH[state] ?? '?'} ${escapeForDisplay(state)}`]
  if (pairs.kind !== undefined) bits.push(`kind=${escapeForDisplay(pairs.kind)}`)
  if (pairs.progress !== undefined) bits.push(`${escapeForDisplay(pairs.progress)}%`)
  if (pairs.app !== undefined) bits.push(`app=${escapeForDisplay(pairs.app)}`)
  if (pairs.id !== undefined) bits.push(`id=${escapeForDisplay(pairs.id)}`)
  if (decoded.title !== undefined) bits.push(`title="${escapeForDisplay(decoded.title)}"`)
  if (decoded.msg !== undefined) bits.push(`msg="${escapeForDisplay(decoded.msg)}"`)
  const unknown = Object.keys(pairs).filter(key => !KNOWN_KEYS.includes(key))
  if (unknown.length > 0) bits.push(`(未知键: ${unknown.map(escapeForDisplay).join(',')})`)
  return { ok: true, line: bits.join('  ') }
}

/**
 * 处理新到达的一段文本：返回其中**完整**的报告，并把可能还没读完的尾巴
 * （一段 `ESC ] 7501 ;` 开头、还没有终止符的内容）留给下一次调用。
 */
export function scanChunk(text) {
  const entries = []
  let cursor = 0
  for (const match of text.matchAll(/\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    const bytes = Buffer.byteLength(match[0], 'utf8')
    entries.push(bytes > MAX_SEQUENCE_BYTES
      ? { ok: false, reason: `序列超过 ${MAX_SEQUENCE_BYTES} 字节上限`, detail: `${bytes} bytes` }
      : interpretReport(match[1] ?? ''))
    cursor = (match.index ?? 0) + match[0].length
  }
  return { entries, pending: retainPending(text.slice(cursor)) }
}

/** 只保留可能长成报告的那条尾巴（最后一段未终止的 `ESC ] 7501 ;`）。 */
function retainPending(rest) {
  const start = rest.lastIndexOf(REPORT_PREFIX)
  if (start < 0) {
    // 读取也可能断在 introducer 内；只留下能接成报告前缀的尾巴。
    for (let length = REPORT_PREFIX.length - 1; length > 0; length--) {
      if (rest.endsWith(REPORT_PREFIX.slice(0, length))) return rest.slice(-length)
    }
    return ''
  }
  const pending = rest.slice(start)
  // 超过整条序列上限的内容永远不可能成为合法报告；留着只会让一份恶意日志
  // 把内存撑大（也永远不会被消费）。
  return Buffer.byteLength(pending, 'utf8') > MAX_SEQUENCE_BYTES ? '' : pending
}

/**
 * 增量读取一个**增长或截断**的字节源：只读上次之后新增的字节，跨读取边界的
 * 半条报告由 `scanChunk` 的尾巴兜住，源被截断（长度缩回）时位置与尾巴一起
 * 自动重置。
 *
 * 被**换掉**的源（轮转、删掉重建）光看长度发现不了：新内容不比旧的短时长度
 * 只会变大。所以调用方发现路径换了文件时要自己调 `reset()`——位置、半条尾巴
 * 与旧句柄都属于上一个文件，新文件必须从 0 读起。
 *
 * `size()` 返回源当前字节长度；`read(offset, length)` 返回 Buffer（也兼容已解码
 * 的文本）。每次 poll 最多读 64 KiB，调用方可继续 poll 消费剩余字节；UTF-8
 * 跨块字节与半条报告均留到下一块。源被替换后由调用方换句柄并 reset。
 */
export function createIncrementalTail({ read, size }) {
  let offset = 0
  let pending = ''
  let decoder = new StringDecoder('utf8')
  return {
    /** 已消费到的源偏移。 */
    offset: () => offset,
    /** 跨边界留待补全的半条报告。 */
    pending: () => pending,
    /** 丢弃读取位置与半条尾巴，让下一次 poll 从字节 0 重新读。 */
    reset() {
      offset = 0
      pending = ''
      decoder = new StringDecoder('utf8')
    },
    /** 有界读取下一块，返回其中完整的报告。 */
    poll() {
      const total = size()
      if (total < offset) {
        // 截断：旧位置与新尾巴都对不上新内容了。
        offset = 0
        pending = ''
        decoder = new StringDecoder('utf8')
      }
      if (total === offset) return []
      const length = Math.min(total - offset, 64 * 1024)
      const chunk = read(offset, length)
      offset += typeof chunk === 'string' ? length : chunk.length
      const scanned = scanChunk(pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk)))
      pending = scanned.pending
      return scanned.entries
    },
  }
}
