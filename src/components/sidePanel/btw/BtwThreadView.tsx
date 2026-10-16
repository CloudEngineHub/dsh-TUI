/**
 * BtwThreadView：Q/A 轮次的滚动列表（面板 / 全屏场景 / 浮层 fallback
 * 共用）。Question 走用户侧视觉（accent 加粗，无行首箭头），Answer 走共享
 * Markdown；运行中显示本轮 spinner；失败或中止时保留已流出的部分答复，
 * 下面标出错误/已中止。
 *
 * 跟尾：默认跟随尾部；用户上滚后暂停 follow，
 * 出现「有新回答」跳尾提示（点击回底）。ScrollBox 的 sticky 位就是
 * follow 信号——上滚打破 sticky，scrollToBottom/贴底恢复。
 *
 * 消息区不是控件：点它跟点面板其它地方一样，只由宿主把列焦点交给面板
 * （见 BtwComposer 的点击注释），注入/复制的入口是选中轮 + `s`/`c`。
 * 选中只看标题那一行：反色只覆盖标题本身的字，终端光标也声明在那儿。
 * 选中轮滚出视口时只滚到「恰好露出这一行」：往上走贴视口顶、往下走贴视口底；
 * 已经在视口里就只挪高亮，不动滚动位置。
 */
import React from 'react'
import { Box, Text, ScrollBox, type ScrollBoxHandle } from '../../../ui.js'
import { Markdown } from '../../Markdown.js'
import { SpinnerGlyph } from '../../Spinner/SpinnerGlyph.js'
import { t } from '../../../i18n.js'
import { useDeclaredCursor, useNativeCursor } from '../../../ink/hooks/use-declared-cursor.js'
import type { DOMElement } from '../../../ink/dom.js'
import { getBtwContextTurns, subscribeBtwContextTurns } from '../../../tuiDisplayPrefs.js'
import type { BtwThreadSnapshot } from './threads.js'

/** 80ms spinner 帧（只在有 running 轮且其还没收到首段文本时走时钟）。 */
const SPINNER_MS = 80

/** 空态：一句「还没有」+ 这是什么 + 上下文口径（三条信息各一行，不再一行裸文案）。 */
function BtwEmptyState({ contextTurns }: { readonly contextTurns: number }): React.ReactNode {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box marginTop={1}>
        <Text color="subtle" wrap="truncate">{t('btw-thread-empty')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="subtle" wrap="wrap">{t('btw-empty-lines')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic wrap="wrap">{t('btw-thread-context-recent', { n: contextTurns })}</Text>
      </Box>
    </Box>
  )
}

/**
 * 一轮的标题行（问题）。选中 = 只反色标题本身的字（不铺满整行），并把终端
 * 光标声明在这一行上：按 ↑/↓ 时原生光标的拖尾是「在标题之间上下走」，而不是
 * 掉到屏幕左下角（没有声明时渲染器的兜底位置）。点这一行 = 把高亮挪过来
 * （`onSelect`），点击继续冒泡，宿主照旧拿到列焦点。
 */
function QuestionRow({ turnId, text, selected, onSelect, onRegister }: {
  readonly turnId: string
  readonly text: string
  readonly selected: boolean
  readonly onSelect?: ((turnId: string) => void) | undefined
  /** 把这一行的 DOM 节点交给列表：选中滚出视口时按它的位置做最小滚动。 */
  readonly onRegister?: ((turnId: string, node: DOMElement | null) => void) | undefined
}): React.ReactNode {
  const native = useNativeCursor()
  // 与 ListItem 同款：移动期间可见、静止 500ms 后收起，形状/闪烁归终端。
  const cursorRef = useDeclaredCursor({ line: 0, column: 0, active: selected, visible: native, hideOnIdle: native })
  // 组装 ref 时必须把 cursorRef 的 cleanup 转交出去（React 19 用返回值当卸载
  // 清理），否则这一行被删掉时光标声明会留在原地。
  const setNode = React.useCallback((node: DOMElement | null) => {
    const cleanup = cursorRef(node)
    onRegister?.(turnId, node)
    return () => {
      if (typeof cleanup === 'function') cleanup()
      onRegister?.(turnId, null)
    }
  }, [cursorRef, onRegister, turnId])
  return (
    <Box
      ref={setNode}
      onClick={onSelect === undefined ? undefined : () => onSelect(turnId)}
    >
      <Text color="accent" bold inverse={selected} wrap="wrap">{text}</Text>
    </Box>
  )
}

export function BtwThreadView({
  thread,
  width,
  height,
  /** 渲时钟的开关（面板不可见/场景失焦时停表）。 */
  alive,
  /** 当前选中的轮（标题反色 + 光标声明）；undefined = 列表没有选中态。 */
  selectedTurnId,
  /** 点标题行把选中挪到那一轮（继续冒泡，宿主照旧拿列焦点）。 */
  onSelectTurn,
  /** 宿主（全屏场景/浮层）接管键盘滚动用的句柄透传。 */
  scrollHandleRef,
}: {
  readonly thread: BtwThreadSnapshot | undefined
  readonly width: number
  /** 滚动区行预算（含滚动区自身；跳尾提示一行另计）。 */
  readonly height: number
  readonly alive: boolean
  readonly selectedTurnId?: string | undefined
  readonly onSelectTurn?: ((turnId: string) => void) | undefined
  readonly scrollHandleRef?: { current: ScrollBoxHandle | null }
}): React.ReactNode {
  const localScrollRef = React.useRef<ScrollBoxHandle | null>(null)
  // 上下文覆盖提示跟随 dsh-tui.btw.contextTurns 的活值（/settings 改完即换词）。
  const contextTurns = React.useSyncExternalStore(subscribeBtwContextTurns, getBtwContextTurns)
  const scrollRef = scrollHandleRef ?? localScrollRef
  const [frame, setFrame] = React.useState(0)
  const [follow, setFollow] = React.useState(true)
  const [pendingJump, setPendingJump] = React.useState(false)

  const activeTurn = thread === undefined
    ? undefined
    : thread.turns.find(turn => turn.turnId === thread.activeTurnId)
  const spinning = alive && activeTurn !== undefined && activeTurn.answer === ''

  React.useEffect(() => {
    if (!spinning) return
    const interval = setInterval(() => setFrame(previous => previous + 1), SPINNER_MS)
    return () => clearInterval(interval)
  }, [spinning])

  // 滚动订阅：sticky 位翻转 = follow 翻转（上滚离开底部即暂停跟尾）。
  // 空线程时不渲染 ScrollBox——turns 首次出现后（hasTurns 翻转）重新绑定。
  const hasTurns = thread !== undefined && thread.turns.length > 0
  React.useEffect(() => {
    if (!hasTurns) return
    const handle = scrollRef.current
    if (handle === null) return
    return handle.subscribe(() => {
      const sticky = handle.isSticky()
      setFollow(previous => (previous === sticky ? previous : sticky))
      if (sticky) setPendingJump(false)
    })
  }, [hasTurns])

  // 内容增长：跟尾则钉底；暂停跟尾且有新答案内容时亮「有新回答」。
  const version = thread?.version ?? 0
  const answerLengths = React.useMemo(
    () => thread?.turns.map(turn => turn.answer.length).join(',') ?? '',
    [thread],
  )
  const prevRef = React.useRef({ version: 0, answerLengths: '' })
  React.useEffect(() => {
    const previous = prevRef.current
    prevRef.current = { version, answerLengths }
    if (version === 0 || previous.version === 0) return
    const grew = answerLengths !== previous.answerLengths
    if (!grew) return
    if (follow) scrollRef.current?.scrollToBottom()
    else setPendingJump(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, answerLengths, follow])

  // ── 选中轮的最小滚动揭示 ─────────────────────────────────────────────
  // 行节点表：QuestionRow 挂载时交进来；滚动位置一律走 ScrollBox 的
  // scrollToElement（位置在渲染期读元素 Yoga top，不会用到过期数字）。
  const rowNodes = React.useRef(new Map<string, DOMElement>())
  const registerRow = React.useCallback((turnId: string, node: DOMElement | null) => {
    if (node === null) rowNodes.current.delete(turnId)
    else rowNodes.current.set(turnId, node)
  }, [])
  /**
   * 节点在滚动内容里的行号（不含滚动位移）：沿祖先累加 Yoga top，直到撞上滚动
   * 容器（ScrollBox 的节点上才有 scrollTop）。没撞到（浮层回退等无滚动区形态）
   * 返回 undefined——宁可不滚，也不要按错误的坐标系乱跳。
   */
  const contentRowOf = (node: DOMElement): number | undefined => {
    let rows = 0
    let current: DOMElement | undefined = node
    while (current !== undefined && current.parentNode !== undefined) {
      if (current.parentNode.scrollTop !== undefined) return rows
      rows += current.yogaNode?.getComputedTop() ?? 0
      current = current.parentNode
    }
    return undefined
  }
  const previousSelectedRef = React.useRef<string | undefined>(undefined)
  React.useLayoutEffect(() => {
    const previous = previousSelectedRef.current
    previousSelectedRef.current = selectedTurnId
    // 从编辑层或主输入框回列表时也要揭示：长答案跟尾后，标题可能在视口外。
    if (selectedTurnId === undefined || previous === selectedTurnId) return
    const handle = scrollRef.current
    const node = rowNodes.current.get(selectedTurnId)
    if (handle === null || node === undefined) return
    const viewport = handle.getViewportHeight()
    if (viewport <= 0) return
    const rows = Math.max(1, Math.ceil(node.yogaNode?.getComputedHeight() ?? 1))
    const top = contentRowOf(node)
    if (top === undefined) return
    const scrollTop = handle.getScrollTop()
    // 用算好的内容行号直接 scrollTo：scrollToElement 读的是元素相对**父节点**的
    // top，标题盒子嵌在 turn 里，用它会把滚动甩到内容顶部。布局已稳定（只有选中
    // 变了），这里的数字不会过期。
    // 往上走出视口 → 贴视口顶；往下走出视口 → 整行贴视口底（恰好露出，不多滚）。
    if (top < scrollTop) handle.scrollTo(top)
    else if (top + rows > scrollTop + viewport) handle.scrollTo(top + rows - viewport)
  }, [selectedTurnId])

  const jumpTail = React.useCallback(() => {
    scrollRef.current?.scrollToBottom()
    setFollow(true)
    setPendingJump(false)
  }, [])

  if (thread === undefined || thread.turns.length === 0) return <BtwEmptyState contextTurns={contextTurns} />

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
      <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} stickyScroll>
        {thread.turns.map((turn, index) => (
          <Box key={turn.turnId} flexDirection="column">
            {index > 0 && <Text dimColor>{'┈'.repeat(Math.max(4, width - 2))}</Text>}
            {/* 标题行：问题靠 accent 色 + 加粗与答案区分、选中时整行反色；
                行首不再挂箭头——输入框的 `›` 是这套视觉语言里唯一的箭头。 */}
            <QuestionRow
              turnId={turn.turnId}
              text={turn.question}
              selected={turn.turnId === selectedTurnId}
              onSelect={onSelectTurn}
              onRegister={registerRow}
            />
            <Box marginLeft={2} flexDirection="column">
              {turn.phase === 'completed' ? (
                <Markdown cacheTokens={false}>{turn.answer}</Markdown>
              ) : turn.phase === 'failed' || turn.phase === 'cancelled' ? (
                // What streamed before the failure or the abort stays readable
                // above the marker.
                <>
                  {turn.answer !== '' && <Markdown cacheTokens={false}>{turn.answer}</Markdown>}
                  {turn.phase === 'failed'
                    ? <Text color="error" wrap="wrap">{t('btw-thread-error')}{turn.error === undefined ? '' : ': ' + turn.error}</Text>
                    : <Text dimColor italic>{t('btw-thread-cancelled')}</Text>}
                </>
              ) : turn.answer !== '' ? (
                <Markdown cacheTokens={false}>{turn.answer}</Markdown>
              ) : (
                <Box flexShrink={0}>
                  <SpinnerGlyph frame={frame} messageColor="warning" />
                  <Text color="warning"> {t('btw-answering')}</Text>
                </Box>
              )}
              {turn.omittedOlderCount > 0 && (
                <Text dimColor italic wrap="truncate">
                  {t('btw-thread-context-omitted', { n: turn.omittedOlderCount })}
                </Text>
              )}
            </Box>
          </Box>
        ))}
      </ScrollBox>
      {pendingJump && !follow && (
        <Box flexShrink={0} onClick={event => { event.stopImmediatePropagation(); jumpTail() }}>
          <Text color="permission">↓ {t('btw-thread-unread')}</Text>
        </Box>
      )}
    </Box>
  )
}
