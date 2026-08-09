import { useMemo, useState } from 'react'
import { Segmented, Space } from 'antd'
import type { FeedEntry } from '../types'
import { LiveConsole } from '../components/LiveConsole'
import { PHASE_LABEL } from '../format'

type PhaseFilter = 'all' | keyof typeof PHASE_LABEL

export function LiveFeedPage({ feed }: { feed: FeedEntry[] }) {
  const [filter, setFilter] = useState<PhaseFilter>('all')

  const filtered = useMemo(() => {
    if (filter === 'all') return feed
    return feed.filter((entry) => !('phase' in entry.event) || entry.event.phase === filter)
  }, [feed, filter])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented
        value={filter}
        onChange={(v) => setFilter(v as PhaseFilter)}
        options={[
          { label: 'All phases', value: 'all' },
          { label: PHASE_LABEL.research_plan, value: 'research_plan' },
          { label: PHASE_LABEL.act, value: 'act' },
          { label: PHASE_LABEL.reflect, value: 'reflect' },
        ]}
      />
      <LiveConsole feed={filtered} height="calc(100vh - 220px)" />
    </Space>
  )
}
