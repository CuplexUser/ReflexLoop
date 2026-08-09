import { useEffect, useReducer, useRef } from 'react'
import type { AgentEvent, FeedEntry, ProposalRow } from './types'

const FEED_LIMIT = 400

interface SocketState {
  connection: 'connecting' | 'open' | 'closed'
  domains: string[]
  feed: FeedEntry[]
  /** Proposals currently awaiting a decision -- several can be pending review at once. */
  pendingProposals: ProposalRow[]
  runningPhase: { phase: string; proposalId: number | null } | null
  /** Bumped only on events that mean "REST history/status is now stale" -- pages use this as a refetch trigger. */
  historyVersion: number
}

const HISTORY_CHANGING_EVENTS = new Set<AgentEvent['type']>([
  'proposal_pending',
  'proposal_decided',
  'outcome_recorded',
  'lesson_saved',
  'phase_done',
])

type Action = { type: 'connection'; connection: SocketState['connection'] } | { type: 'event'; event: AgentEvent }

let seq = 0

function reducer(state: SocketState, action: Action): SocketState {
  if (action.type === 'connection') {
    return { ...state, connection: action.connection }
  }

  const event = action.event
  const feed: FeedEntry[] = [...state.feed, { key: `e${seq++}`, at: Date.now(), event }].slice(-FEED_LIMIT)
  const next: SocketState = {
    ...state,
    feed,
    historyVersion: HISTORY_CHANGING_EVENTS.has(event.type) ? state.historyVersion + 1 : state.historyVersion,
  }

  switch (event.type) {
    case 'run_started':
      return { ...next, domains: event.domains }
    case 'phase_start':
      return { ...next, runningPhase: { phase: event.phase, proposalId: event.proposalId } }
    case 'phase_done':
      return { ...next, runningPhase: null }
    case 'proposal_pending':
      return {
        ...next,
        pendingProposals: state.pendingProposals.some((p) => p.id === event.proposal.id)
          ? state.pendingProposals
          : [...state.pendingProposals, event.proposal],
      }
    case 'proposal_decided':
      return {
        ...next,
        pendingProposals: state.pendingProposals.filter((p) => p.id !== event.proposal.id),
      }
    default:
      return next
  }
}

export function useAgentSocket() {
  const [state, dispatch] = useReducer(reducer, {
    connection: 'connecting',
    domains: [],
    feed: [],
    pendingProposals: [],
    runningPhase: null,
    historyVersion: 0,
  })
  const retryDelay = useRef(1000)

  useEffect(() => {
    let socket: WebSocket
    let closedByEffect = false
    let retryTimer: ReturnType<typeof setTimeout>

    function connect() {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      socket = new WebSocket(url)
      dispatch({ type: 'connection', connection: 'connecting' })

      socket.onopen = () => {
        retryDelay.current = 1000
        dispatch({ type: 'connection', connection: 'open' })
      }
      socket.onmessage = (msg) => {
        try {
          dispatch({ type: 'event', event: JSON.parse(msg.data) as AgentEvent })
        } catch {
          // ignore malformed frames
        }
      }
      socket.onclose = () => {
        dispatch({ type: 'connection', connection: 'closed' })
        if (closedByEffect) return
        retryTimer = setTimeout(connect, retryDelay.current)
        retryDelay.current = Math.min(retryDelay.current * 1.5, 15000)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      closedByEffect = true
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  return state
}
