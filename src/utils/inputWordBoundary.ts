/** Previous whitespace-delimited word start (readline Alt+B / Ctrl+W). */
export function wordBoundaryLeft(text: string, cursor: number): number {
  let index = cursor
  while (index > 0 && /\s/.test(text[index - 1]!)) index--
  while (index > 0 && !/\s/.test(text[index - 1]!)) index--
  return index
}

/** Next whitespace-delimited word start (readline Alt+F). */
export function wordBoundaryRight(text: string, cursor: number): number {
  let index = cursor
  while (index < text.length && !/\s/.test(text[index]!)) index++
  while (index < text.length && /\s/.test(text[index]!)) index++
  return index
}
