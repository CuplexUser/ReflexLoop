import { useEffect, useState } from 'react'
import { Badge, Layout, Menu, Typography } from 'antd'
import {
  BulbOutlined,
  CodeOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAgentSocket } from './useAgentSocket'
import { api } from './api'
import { StatusBar } from './components/StatusBar'
import { DashboardPage } from './pages/DashboardPage'
import { LiveFeedPage } from './pages/LiveFeedPage'
import { ProposalsPage } from './pages/ProposalsPage'
import { ActionsPage } from './pages/ActionsPage'
import { LessonsPage } from './pages/LessonsPage'
import { ResearchPage } from './pages/ResearchPage'
import type { OutcomeRow, ProposalRow, StatusResponse } from './types'

type PageKey = 'dashboard' | 'live' | 'proposals' | 'actions' | 'lessons' | 'research'

function App() {
  const socket = useAgentSocket()
  const [page, setPage] = useState<PageKey>('dashboard')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [proposals, setProposals] = useState<ProposalRow[]>([])
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([])

  useEffect(() => {
    Promise.all([api.status(), api.proposals(), api.outcomes()])
      .then(([s, p, o]) => {
        setStatus(s)
        setProposals(p)
        setOutcomes(o)
      })
      .catch(() => {
        // transient during a backend restart; the next historyVersion bump retries
      })
  }, [socket.historyVersion])

  const pendingCount = Math.max(proposals.filter((p) => p.status === 'pending').length, socket.pendingProposals.length)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={220} breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: '20px 24px 12px' }}>
          <Typography.Title level={5} style={{ margin: 0, color: '#E7EAF0' }}>
            agent-runner
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            operator console
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => setPage(e.key as PageKey)}
          items={[
            { key: 'dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
            { key: 'live', icon: <CodeOutlined />, label: 'Live feed' },
            {
              key: 'proposals',
              icon: <FileTextOutlined />,
              label: (
                <Badge count={pendingCount} size="small" offset={[8, 0]}>
                  <span>Proposals</span>
                </Badge>
              ),
            },
            { key: 'actions', icon: <ThunderboltOutlined />, label: 'Actions' },
            { key: 'lessons', icon: <BulbOutlined />, label: 'Lessons' },
            { key: 'research', icon: <ExperimentOutlined />, label: 'Research notes' },
          ]}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', paddingInline: 24 }}>
          <StatusBar
            connection={socket.connection}
            domains={socket.domains.length > 0 ? socket.domains : (status?.domains ?? [])}
            runningPhase={socket.runningPhase}
          />
        </Layout.Header>

        <Layout.Content style={{ margin: 24 }}>
          {page === 'dashboard' && (
            <DashboardPage
              pendingProposals={socket.pendingProposals}
              proposals={proposals}
              outcomes={outcomes}
              totalCostUsd={status?.totalCostUsd ?? 0}
              feed={socket.feed}
              onOpenLiveFeed={() => setPage('live')}
            />
          )}
          {page === 'live' && <LiveFeedPage feed={socket.feed} />}
          {page === 'proposals' && <ProposalsPage proposals={proposals} outcomes={outcomes} />}
          {page === 'actions' && <ActionsPage historyVersion={socket.historyVersion} />}
          {page === 'lessons' && <LessonsPage historyVersion={socket.historyVersion} />}
          {page === 'research' && <ResearchPage historyVersion={socket.historyVersion} />}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}

export default App
