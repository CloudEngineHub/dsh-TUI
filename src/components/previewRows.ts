/**
 * Preview text clipped to a row budget — the shared bound for in-flow panels
 * that show backend-authored text (an approval's command/reason/title, a
 * questionnaire's question/detail) above their interactive tail.
 *
 * Those panels sit in the bottom chrome with `flexShrink: 0`, so their height
 * IS their content height: unbounded text pushed the option rows and the key
 * hint past the viewport, and the renderer clips rows below the screen — the
 * user saw a wall of command text and no button to answer (#1664). Wrapping
 * to the real content width first is what makes the budget exact: counting
 * `split('\n')` rows under `wrap="wrap"` undercounts every long line.
 *
 * The caller renders one row per entry, then the omitted marker when
 * `omitted > 0`. `rows.length + (omitted > 0 ? 1 : 0)` never exceeds
 * `maxRows`, so a caller can subtract that from its budget.
 */
import wrapText from '../ink/wrap-text.js'
import type { ScrollBoxHandle } from '../ui.js'

/** Page immediately: keyboard navigation must not leave queued wheel motion. */
export function pagePreview(scroll: ScrollBoxHandle | null, direction: -1 | 1): void {
  if (scroll === null) return
  const rows = scroll.getViewportHeight()
  const maxTop = Math.max(0, scroll.getFreshScrollHeight() - rows)
  const next = scroll.getScrollTop() + direction * Math.max(1, rows - 1)
  scroll.scrollTo(Math.max(0, Math.min(maxTop, next)))
}

export interface PreviewRowView {
  /** Display rows to paint, each at most `cells` wide, in order. */
  readonly rows: readonly string[]
  /** Source rows that did not fit under the budget (0 = nothing cut). */
  readonly omitted: number
}

/**
 * Wrap `text` to `cells` display cells and keep at most `maxRows` rows,
 * reserving the last row for the omitted marker when anything is cut.
 *
 * @param text - the backend text (may contain newlines, wide chars, ANSI).
 * @param cells - content width in display cells (the row's real width).
 * @param maxRows - rows this block may occupy, marker included (≥1).
 */
export function clipPreviewRows(text: string, cells: number, maxRows: number): PreviewRowView {
  // wrapText hard-wraps at `cells`, so every returned row renders as exactly
  // one row (the Text node re-wraps but each line already fits).
  const rows = wrapText(text, Math.max(1, Math.floor(cells)), 'wrap').split('\n')
  const budget = Math.max(1, Math.floor(maxRows))
  if (rows.length <= budget) return { rows, omitted: 0 }
  // A one-row budget can only say "there is more"; two rows show the first
  // line plus the marker, and so on.
  const shown = budget >= 2 ? rows.slice(0, budget - 1) : []
  return { rows: shown, omitted: rows.length - shown.length }
}
