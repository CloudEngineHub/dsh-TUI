import React from 'react'
import { useTerminalTitle } from '../ink/hooks/use-terminal-title.js'

const FRAMES = ['⠂', '⠐']

/** Keep terminal-title ticks out of the transcript's render owner. */
export function ChatTitle({ title, working, focused }: {
  title: string
  working: boolean
  focused: boolean
}): null {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!working || !focused) return
    const interval = setInterval(() => setFrame(value => (value + 1) % FRAMES.length), 960)
    return () => clearInterval(interval)
  }, [working, focused])
  useTerminalTitle(`${working ? FRAMES[frame] : '✦'} 🐋 ${title}`)
  return null
}
