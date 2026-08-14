import { useEffect, useState } from 'react'
import type { ToolInfo, ToolRisk } from '../types'
import { api } from '../api'

/**
 * The server's tool catalog as a name -> risk lookup, so the console can badge which of a
 * proposal's requested tools actually touch the world. Fetched rather than hardcoded: the
 * backend validates operator edits against this same list, and a stale copy here would badge
 * a real tool as unknown.
 */
export function useToolCatalog() {
  const [catalog, setCatalog] = useState<Map<string, ToolRisk>>(new Map())

  useEffect(() => {
    let cancelled = false
    api
      .tools()
      .then((tools: ToolInfo[]) => {
        if (!cancelled) setCatalog(new Map(tools.map((t) => [t.name, t.risk])))
      })
      .catch(() => {
        // Unreachable catalog just means no risk badges; the fence itself is enforced server-side.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return catalog
}
