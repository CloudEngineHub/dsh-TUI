/**
 * The approval panel — the permission prompt every backend renders
 * through. One ask per panel: a
 * permission-colored divider header naming the tool, the gated command, the
 * asker's reason, "Allow this operation?", and a numbered option list.
 *
 * The options come from the request (`approval.options`); a request without
 * them — every DSH ask — offers exactly the DSH protocol's two rows (allow
 * once / reject), whose outcome set is closed with no allow-always or
 * feedback channel. A backend prompt may add an allow-always row (its label
 * says what would be remembered), hide it (`suppressAlwaysAllow`, a forcing
 * ask rule), put the rejection first with no one-key approve
 * (`defaultToNo`), and accept a typed reason with a rejection (`feedback`).
 * Esc and Ctrl+C reject (fail closed; Esc cancels the request).
 *
 * On a prompt that takes a reason, the reason is typed into the rejection
 * row once it has focus (↓ / Tab): there digits are text, so a reason that
 * starts with "2" can never pick allow-always, and allow-always is never a
 * digit shortcut — it takes focus plus Enter. The reason shows as at most
 * two lines (its tail, where the typing happens); the full text is sent.
 * A DSH prompt (two rows, no reason) keeps its digit shortcuts unchanged.
 * Every decision carries the panel key, so a keystroke this panel handles
 * after its prompt was withdrawn cannot answer the next one.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, ScrollBox, useInput, useTerminalSize, type ScrollBoxHandle } from '../../ui.js'
import wrapText from '../../ink/wrap-text.js'
import { actionMatches, effectiveComboDisplay } from '../../utils/keymap.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { flattenPasteInline } from '../../channel/sanitize.js'
import { clipPreviewRows, pagePreview, type PreviewRowView } from '../previewRows.js'
import {
  panelOutcomeOf,
  visiblePermissionOptions,
  type PermissionPanelDecision,
  type PermissionPanelOutcome,
  type PermissionPanelSnapshot,
} from '../../channel/permissions.js'
import type { PermissionOptionView } from '../../agent/events.js'

export type ApprovalPanelProps = {
  /** The approval to render (a permission store snapshot). */
  readonly approval: PermissionPanelSnapshot
  /** True when the asking agent is NOT the attached session — a background
   *  (agent view) session's ask, answered from the same single panel. */
  readonly background?: boolean
  /**
   * The user's choice: the outcome (`allowed-once` / `rejected` for the DSH
   * two-row prompt, plus `allowed-always`) and the picked option with any
   * typed rejection reason.
   */
  readonly onDecide: (outcome: PermissionPanelOutcome, decision: PermissionPanelDecision) => void
}

/** A feedback reason is a short sentence, not a document. */
const FEEDBACK_MAX_POINTS = 2000

/** Horizontal cells the panel spends outside an option's text: the
 *  padding (2 + 2) and the focus pointer column. */
const ROW_CHROME_CELLS = 5
/** The reason never takes more than this many rows of the option list. */
const FEEDBACK_MAX_LINES = 2

/**
 * Preview caps. The panel is in-flow in the bottom chrome, so its height is
 * its content height: an unbounded command pushed the question, the option
 * rows and the hint off screen and left the user nothing to answer (#1664).
 * These caps are the worst case; the terminal-row budget below shrinks them
 * further on a short terminal.
 */
const COMMAND_MAX_LINES = 8
const TITLE_MAX_LINES = 3
const REASON_MAX_LINES = 3

/**
 * Rows kept for the rest of the bottom chrome while this panel is up: the
 * status line plus a floor of transcript rows. The composer does not count —
 * Chat replaces it with this panel (`PromptInput` stays mounted but suspended,
 * rendering nothing). The value deliberately matches the picker overlay's
 * prompt-slot reserve so both surfaces leave the same footer budget; the two
 * stay separate literals because the overlay's composer IS on screen.
 */
const CHROME_RESERVED_ROWS = 8
/** Compact prompts spend the transcript reserve but keep the three-row footer. */
const COMPACT_FOOTER_ROWS = 3

/** The longest tail of `text` that fits in `cells` display cells. */
function tailWithin(text: string, cells: number): string {
  const points = [...text]
  let width = 0
  let start = points.length
  while (start > 0) {
    const next = stringWidth(points[start - 1]!)
    if (width + next > cells) break
    width += next
    start -= 1
  }
  return points.slice(start).join('')
}

/** Hard-wrap `text` into rows of at most `cells` display cells. */
function hardWrap(text: string, cells: number): string[] {
  const rows: string[] = []
  let row = ''
  let width = 0
  for (const point of text) {
    const next = stringWidth(point)
    if (width + next > cells && row !== '') {
      rows.push(row)
      row = ''
      width = 0
    }
    row += point
    width += next
  }
  if (row !== '' || rows.length === 0) rows.push(row)
  return rows
}

/**
 * The rejection row with its reason, as at most two hard-wrapped rows: when
 * the reason does not fit, its tail (the typing position) is shown after an
 * ellipsis.
 */
export function feedbackRowLines(prefix: string, label: string, reason: string, columns: number, maxLines: 1 | 2 = FEEDBACK_MAX_LINES): string[] {
  const cells = Math.max(8, columns - ROW_CHROME_CELLS)
  const head = `${prefix}${t('approval-feedback-row', { label, reason: '' })}`
  const budget = maxLines * cells - stringWidth(head)
  const shown = stringWidth(reason) <= budget ? reason : `…${tailWithin(reason, Math.max(0, budget - 1))}`
  return hardWrap(`${prefix}${t('approval-feedback-row', { label, reason: shown })}`, cells).slice(0, maxLines)
}

/** The localized label of an option without backend wording. */
function optionLabel(option: PermissionOptionView): string {
  if (option.label !== undefined && option.label !== '') return option.label
  return option.kind === 'allow-once' ? t('approval-yes') : option.kind === 'allow-always' ? t('approval-always') : t('approval-no')
}

export function ApprovalPanel({ approval, background = false, onDecide }: ApprovalPanelProps): React.ReactNode {
  const options = visiblePermissionOptions(approval)
  const { columns, rows } = useTerminalSize()
  // `defaultToNo` opens on the rejection (sorted first); otherwise on the
  // first option, as the DSH panel always has. The ref is the synchronous
  // source of truth: one stdin chunk can carry a focus move and the typing
  // after it inside a single React batch.
  const [focusIndex, setFocusIndexState] = React.useState(0)
  const focusRef = React.useRef(0)
  const setFocusIndex = (next: number | ((index: number) => number)): void => {
    focusRef.current = typeof next === 'function' ? next(focusRef.current) : next
    setFocusIndexState(focusRef.current)
  }
  // Hover highlight per decision row (mouse affordance; the click handler
  // below mirrors the keyboard Enter on the focused row).
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const acceptsFeedback = approval.feedback === true
  const [feedback, setFeedback] = React.useState('')
  // One stdin chunk can carry several key events inside a single React
  // batch: the ref is the synchronous source of truth for the handlers.
  const feedbackRef = React.useRef('')
  const previewScrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const applyFeedback = (next: string): void => {
    feedbackRef.current = next
    setFeedback(next)
  }
  const rejectIndex = options.findIndex(option => option.kind === 'reject')

  const decide = (index: number, withFeedback: boolean): void => {
    const option = options[index]
    if (option === undefined) return
    const text = withFeedback && option.kind === 'reject' ? feedbackRef.current.trim() : ''
    onDecide(panelOutcomeOf(option.kind), {
      optionId: option.id,
      kind: option.kind,
      key: approval.key,
      ...(text === '' ? {} : { feedback: text }),
    })
  }
  /** Esc / Ctrl+C: the plain rejection (a typed reason is not sent). */
  const reject = (): void => {
    if (rejectIndex >= 0) decide(rejectIndex, false)
    else onDecide('rejected', { optionId: 'reject', kind: 'reject', key: approval.key })
  }
  /** The reason field is the focused rejection row of a prompt that takes one. */
  const reasonFocused = (): boolean => acceptsFeedback && rejectIndex >= 0 && focusRef.current === rejectIndex
  const appendFeedback = (text: string): void => {
    const points = [...feedbackRef.current, ...text]
    applyFeedback(points.slice(0, FEEDBACK_MAX_POINTS).join(''))
  }

  useInput((input, key, event) => {
    if (compact && hasPreview) {
      const up = actionMatches('questionDetailUp', input, key)
      const down = actionMatches('questionDetailDown', input, key)
      if (up || down) {
        pagePreview(previewScrollRef.current, up ? -1 : 1)
        event.stopImmediatePropagation()
        return
      }
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      reject()
      return
    }
    if (key.upArrow || (acceptsFeedback && key.tab && key.shift)) {
      setFocusIndex(index => (index + options.length - 1) % options.length)
      return
    }
    if (key.downArrow || (acceptsFeedback && key.tab)) {
      setFocusIndex(index => (index + 1) % options.length)
      return
    }
    if (isPlainReturnInput(input, key)) {
      decide(focusRef.current, true)
      return
    }
    if (reasonFocused()) {
      // The reason field: everything printable is text, digits included.
      if (key.isPasted === true) {
        const text = flattenPasteInline(input)
        if (text.trim() !== '') appendFeedback(text)
        return
      }
      if (key.backspace) {
        applyFeedback([...feedbackRef.current].slice(0, -1).join(''))
        return
      }
      if (!key.ctrl && !key.meta && input !== '' && !/[\u0000-\u001f\u007f]/u.test(input)) appendFeedback(input)
      return
    }
    // Digits pick an option. With `defaultToNo` no single key approves (only
    // a rejection may be picked); on a prompt that takes a reason the
    // persistent allow-always is never a single key either.
    if (/^[1-9]$/u.test(input)) {
      const index = Number(input) - 1
      const option = options[index]
      if (option === undefined) return
      if (approval.defaultToNo === true && option.kind !== 'reject') return
      if (acceptsFeedback && option.kind === 'allow-always') return
      decide(index, false)
    }
  }, { isActive: true })

  // ── Preview budget ─────────────────────────────────────────────────────
  // The divider, the proceed question, the option rows and the key hint are
  // always painted; the preview text between them must fold instead of
  // growing the panel past the viewport (#1664).
  const contentCells = Math.max(8, columns - 4)
  // The command sits in a Box with paddingX={2} inside the panel's 2+2.
  const commandCells = Math.max(8, columns - 8)
  const warningRows = (background ? 1 : 0)
    + (approval.subagentId === undefined ? 0 : 1)
    + (approval.external === true ? 1 : 0)
    + (approval.blockedPath === undefined ? 0 : 1)
  // root margin + divider + content margin + warnings + "proceed" + options
  // margin + option rows + the focused row's spacer + hint margin + hint.
  const fixedRows = 8 + warningRows + options.length
  const previewBlockCount = (approval.title === undefined ? 0 : 1)
    + (approval.command === undefined ? 0 : 1)
    + (approval.reason === undefined ? 0 : 1)
  const hasPreview = previewBlockCount + warningRows > 0
  // Below this floor even one marker per block would hide a decision row.
  // Remove decorative gaps and put all request text in one bounded viewport.
  const compact = rows < fixedRows + previewBlockCount + COMPACT_FOOTER_ROWS
  const hint = compact && hasPreview
    ? t('approval-hint-preview', { up: effectiveComboDisplay('questionDetailUp'), down: effectiveComboDisplay('questionDetailDown') })
    : acceptsFeedback ? t('approval-hint-feedback') : t('approval-hint')
  const hintRows = wrapText(hint, contentCells, 'wrap').split('\n').length
  // The divider and choices already identify the decision. On a tiny
  // three-choice prompt, drop the repeated question before any request text.
  const showProceed = !compact || rows >= COMPACT_FOOTER_ROWS + 2 + options.length + hintRows + (hasPreview ? 1 : 0)
  const compactPreviewRows = Math.max(1, rows - COMPACT_FOOTER_ROWS - 1 - (showProceed ? 1 : 0) - options.length - hintRows)
  let previewRowsLeft = Math.max(1, rows - fixedRows - CHROME_RESERVED_ROWS)
  // A present text is never dropped: once the budget is spent it still keeps
  // its omitted marker, overdrawing the chrome reserve by at most one row per
  // block. Silently hiding the asker's reason reads as "there was none".
  const takePreview = (text: string | undefined, cells: number, cap: number): PreviewRowView | undefined => {
    if (text === undefined) return undefined
    const view = clipPreviewRows(text, cells, Math.max(1, Math.min(cap, previewRowsLeft)))
    previewRowsLeft = Math.max(0, previewRowsLeft - view.rows.length - (view.omitted > 0 ? 1 : 0))
    return view
  }
  // The gated command is what the decision is about: it takes the budget
  // first, then the backend's reason, then the prompt sentence.
  const commandView = takePreview(approval.command, commandCells, COMMAND_MAX_LINES)
  const reasonView = takePreview(approval.reason, contentCells, REASON_MAX_LINES)
  const titleView = takePreview(approval.title, contentCells, TITLE_MAX_LINES)
  /** Preview rows (already wrapped to one row each) and the omitted marker. */
  const preview = (view: PreviewRowView | undefined, dim = false): React.ReactNode => view === undefined ? null : (
    <>
      {view.rows.length > 0 && (
        <Text dimColor={dim} wrap="wrap">
          {view.rows.join('\n')}
        </Text>
      )}
      {view.omitted > 0 && (
        <Text dimColor wrap="truncate-end">
          {t('panel-preview-omitted', { count: view.omitted })}
        </Text>
      )}
    </>
  )

  const previewContent = (
    <>
      {background && (
        <Text color="warning">
          {t('approval-background-agent', { id: approval.agentId.slice(0, 8) })}
        </Text>
      )}
      {approval.subagentId !== undefined && (
        <Text color="warning">{t('approval-subagent', { id: approval.subagentId.slice(0, 8) })}</Text>
      )}
      {approval.external === true && (
        <Text color="warning" wrap="wrap">[external] {t('approval-external-hint')}</Text>
      )}
      {compact && approval.title !== undefined ? <Text wrap="wrap">{approval.title}</Text> : preview(titleView)}
      {approval.command !== undefined && (
        <Box flexDirection="column" paddingX={2}>
          {compact ? <Text dimColor wrap="wrap">{approval.command}</Text> : preview(commandView, true)}
        </Box>
      )}
      {compact && approval.reason !== undefined ? <Text dimColor wrap="wrap">{approval.reason}</Text> : preview(reasonView, true)}
      {approval.blockedPath !== undefined && (
        <Text color="warning" wrap="wrap">{t('approval-blocked-path', { path: approval.blockedPath })}</Text>
      )}
    </>
  )

  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={t('approval-waiting', { tool: approval.toolName })} />
      <Box flexDirection="column" marginTop={compact ? 0 : 1}>
        {compact && hasPreview ? (
          <ScrollBox ref={previewScrollRef} flexDirection="column" height={compactPreviewRows} flexShrink={0}>
            {previewContent}
          </ScrollBox>
        ) : previewContent}
        {showProceed && <Text dimColor wrap={compact ? 'truncate-end' : 'wrap'}>{t('approval-proceed')}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={compact ? 0 : 1}>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const hovered = index === hoverIndex
          const label = optionLabel(option)
          const reasonLines = acceptsFeedback && option.kind === 'reject' && feedback !== ''
            ? feedbackRowLines(`${index + 1}. `, label, feedback, columns, compact ? 1 : FEEDBACK_MAX_LINES)
            : undefined
          return (
            <Box
              key={option.id}
              flexDirection="row"
              marginTop={!compact && focused ? 1 : 0}
              onClick={() => decide(index, true)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
            >
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'accent' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              {reasonLines === undefined ? (
                <Text bold={focused} color={focused ? 'accent' : undefined} wrap={compact ? 'truncate-end' : 'wrap'}>
                  {index + 1}. {label}
                </Text>
              ) : (
                <Box flexDirection="column">
                  {reasonLines.map((line, row) => (
                    <Text key={row} bold={focused} color={focused ? 'accent' : undefined} wrap="truncate-end">
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={compact ? 0 : 1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}
