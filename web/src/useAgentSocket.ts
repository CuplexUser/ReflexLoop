import { useEffect, useReducer, useRef } from 'react'
import type { AgentEvent, FeedEntry, PersistedEvent, ProposalRow } from './types'
import { api } from './api'

const FEED_LIMIT = 400

interface SocketState {
  connection: 'connecting' | 'open' | 'closed'
  domains: string[]
  feed: FeedEntry[]
  /** Server-assigned event ids already folded into `feed` -- de-dupes the REST history fetch against whatever already arrived live over the socket. */
  seenIds: Set<number>
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

type Action =
  | { type: 'connection'; connection: SocketState['connection'] }
  | { type: 'event'; id: number; occurredAt: string; event: AgentEvent }
  | { type: 'seed'; entries: PersistedEvent[] }

function toFeedEntry(id: number, occurredAt: string, event: AgentEvent): FeedEntry {
  return { key: `e${id}`, at: new Date(occurredAt).getTime(), event }
}

function applyEvent(state: SocketState, event: AgentEvent): SocketState {
  const next: SocketState = {
    ...state,
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

function reducer(state: SocketState, action: Action): SocketState {
  if (action.type === 'connection') {
    return { ...state, connection: action.connection }
  }

  if (action.type === 'seed') {
    // Older-than-anything-seen-live only: any event the socket already
    // delivered has a higher id than what a REST snapshot taken around the
    // same time can contain, so prepending here keeps chronological order.
    const fresh = action.entries.filter((e) => !state.seenIds.has(e.id))
    if (fresh.length === 0) return state
    const seenIds = new Set(state.seenIds)
    for (const e of fresh) seenIds.add(e.id)
    const feed = [...fresh.map((e) => toFeedEntry(e.id, e.occurredAt, e.event)), ...state.feed].slice(-FEED_LIMIT)
    return fresh.reduce((s, e) => applyEvent(s, e.event), { ...state, feed, seenIds })
  }

  if (state.seenIds.has(action.id)) return state // already folded in via the REST seed
  const seenIds = new Set(state.seenIds)
  seenIds.add(action.id)
  const feed: FeedEntry[] = [...state.feed, toFeedEntry(action.id, action.occurredAt, action.event)].slice(-FEED_LIMIT)
  return applyEvent({ ...state, feed, seenIds }, action.event)
}

export function useAgentSocket() {
  const [state, dispatch] = useReducer(reducer, {
    connection: 'connecting',
    domains: [],
    feed: [],
    seenIds: new Set<number>(),
    pendingProposals: [],
    runningPhase: null,
    historyVersion: 0,
  })
  const retryDelay = useRef(1000)

  useEffect(() => {
    api
      .events()
      .then((entries) => dispatch({ type: 'seed', entries }))
      .catch(() => {
        // transient during a backend restart; live events still arrive over the socket
      })
  }, [])

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
          const { id, occurredAt, event } = JSON.parse(msg.data) as { id: number; occurredAt: string; event: AgentEvent }
          dispatch({ type: 'event', id, occurredAt, event })
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
