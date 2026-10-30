/** The agent's recent activity, kept in memory so backers can read it on the agent panel. */
export interface Activity { at: number, line: string }

export function createActivityLog (max = 40, echo: ((line: string) => void) | undefined = line => console.log(`[agent] ${line}`)) {
  const lines: Activity[] = []
  return {
    log: (line: string): void => {
      lines.push({ at: Math.floor(Date.now() / 1000), line })
      if (lines.length > max) lines.shift()
      echo?.(line)
    },
    recent: (): Activity[] => [...lines]
  }
}
