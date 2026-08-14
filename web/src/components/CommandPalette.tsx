import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Empty, Input, Modal, Spin, Tag, Typography, type InputRef } from 'antd'
import { BulbOutlined, ExperimentOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { SearchHit } from '../types'
import { api } from '../api'
import { markdownPreview } from '../format'
import { palette } from '../theme'

const TYPE_META: Record<SearchHit['type'], { label: string; icon: React.ReactNode; path: (hit: SearchHit) => string }> =
  {
    proposal: { label: 'Proposal', icon: <FileTextOutlined />, path: (h) => `/proposals/${h.id}` },
    lesson: { label: 'Lesson', icon: <BulbOutlined />, path: (h) => `/lessons/${h.id}` },
    research_note: { label: 'Research', icon: <ExperimentOutlined />, path: (h) => `/research/${h.id}` },
    // Actions are grouped under their proposal on the Actions page, so that's what we open.
    action: { label: 'Action', icon: <ThunderboltOutlined />, path: (h) => `/actions/${h.proposalId ?? h.id}` },
  }

/**
 * Cmd-K search across everything the console can navigate to. Queries the server rather than
 * filtering in the browser, so it reaches the whole history — and reaches it semantically when
 * Qdrant is configured, the same way the agent reads its own memory.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const inputRef = useRef<InputRef>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setFocusedIndex(0)
    // The modal mounts its content asynchronously; focus once it's actually there.
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    // Debounced: a search can hit Qdrant, so it shouldn't fire on every keystroke.
    const timer = setTimeout(() => {
      api
        .search(trimmed)
        .then((results) => {
          if (cancelled) return
          setHits(results)
          setFocusedIndex(0)
        })
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const grouped = useMemo(() => {
    const order: SearchHit['type'][] = ['proposal', 'action', 'lesson', 'research_note']
    return order.flatMap((type) => hits.filter((h) => h.type === type))
  }, [hits])

  function openHit(hit: SearchHit) {
    navigate(TYPE_META[hit.type].path(hit))
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((i) => Math.min(grouped.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && grouped[focusedIndex]) {
      e.preventDefault()
      openHit(grouped[focusedIndex])
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} destroyOnClose closable={false} styles={{ body: { paddingTop: 4 } }}>
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        placeholder="Search proposals, actions, lessons, research…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        suffix={loading ? <Spin size="small" /> : <Typography.Text type="secondary">esc</Typography.Text>}
      />

      <div style={{ maxHeight: 420, overflowY: 'auto', marginTop: 8 }}>
        {grouped.length === 0 && query.trim() && !loading && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matches" />
        )}
        {grouped.map((hit, index) => (
          <button
            key={`${hit.type}-${hit.id}`}
            type="button"
            onClick={() => openHit(hit)}
            onMouseEnter={() => setFocusedIndex(index)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              padding: '8px 10px',
              background: index === focusedIndex ? palette.bgBase : 'transparent',
              color: 'inherit',
            }}
          >
            <Typography.Text style={{ display: 'block' }}>
              {TYPE_META[hit.type].icon} {hit.title}
              <Tag style={{ marginLeft: 8 }}>{TYPE_META[hit.type].label}</Tag>
              {hit.badge && <Tag color="default">{hit.badge}</Tag>}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {markdownPreview(hit.snippet, 120)}
            </Typography.Text>
          </button>
        ))}
      </div>
    </Modal>
  )
}
