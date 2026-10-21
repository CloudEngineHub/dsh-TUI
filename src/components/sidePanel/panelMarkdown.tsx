import React from 'react'
import { Markdown } from '../Markdown.js'
import type { TuiPanelCodeBlockProps, TuiPanelMarkdownProps } from '../../dsh-adapter/panels.js'

/**
 * 面板内 markdown 正文（kit 成员 `ui.Markdown` 的宿主实现）。
 *
 * `inlineMathImages=false` 关掉行内公式的图片路径：面板不占图片预算，也不想在
 * 一段正文里混进图片协议。块级 `$$` 仍跟随用户的 `mathRendering` 偏好——今天
 * 没有 prop 能关，docs/plugins 写清这一点。
 *
 * 刻意不暴露 `dimColor`（面板不是思考块）与 `cacheTokens`（用默认 true）。
 *
 * prompt 标签块的剥离沿用聊天口径（`stripPromptTags` 默认 true）：面板正文
 * 常是会话内容的再呈现，`<context>` 之类仍是模型内部块。
 */
export function PanelMarkdown({ children }: TuiPanelMarkdownProps): React.ReactNode {
  return <Markdown inlineMathImages={false}>{children}</Markdown>
}

/**
 * 面板内单个代码块（kit 成员 `ui.CodeBlock` 的宿主实现）。
 *
 * 把原始文本围进围栏，复用宿主 markdown 的代码块路径：语言标签、cli-highlight
 * 异步高亮、`dsh-tui.codeFrameStyle` 框样式都跟随用户设置。
 *
 * `stripPromptTags=false`：这个成员承诺「原始代码」，代码里出现 `<context>`
 * 之类字面量时必须逐行保留（`ui.Markdown` 仍走聊天口径）。
 */
export function PanelCodeBlock({ code, language }: TuiPanelCodeBlockProps): React.ReactNode {
  return <Markdown inlineMathImages={false} stripPromptTags={false}>{fenced(code, language)}</Markdown>
}

/**
 * 围栏长度 = max(3, 正文里最长连续反引号 + 1)：正文含 ``` 时用更长的围栏，
 * 否则 markdown 会把它当成收尾围栏、后半段跑出代码块。语言标签剥掉反引号与
 * 空白，否则可以从语言位注入围栏。
 */
export function fenced(code: string, language?: string): string {
  const bar = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1))
  const lang = (language ?? '').replace(/[`\s]/gu, '')
  return `${bar}${lang}\n${code.replace(/\n+$/u, '')}\n${bar}`
}

function longestBacktickRun(code: string): number {
  let longest = 0
  for (const run of code.match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
  return longest
}
