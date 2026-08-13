import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { App as AntApp, Badge, Layout, Menu, Typography } from 'antd'
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

const PAGE_PATHS: Record<PageKey, string> = {
  dashboard: '/',
  live: '/live',
  proposals: '/proposals',
  actions: '/actions',
  lessons: '/lessons',
  research: '/research',
}

function App() {
  const { message } = AntApp.useApp()
  const socket = useAgentSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const page = (Object.keys(PAGE_PATHS) as PageKey[]).find((key) => PAGE_PATHS[key] === location.pathname) ?? 'dashboard'
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

  async function setProposalReview(id: number, reviewStatus: ProposalRow['review_status']) {
    try {
      await api.setProposalReview(id, reviewStatus)
      setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, review_status: reviewStatus } : p)))
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Review update failed')
    }
  }

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
          onClick={(e) => navigate(PAGE_PATHS[e.key as PageKey])}
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
          <Routes>
            <Route
              path="/"
              element={
                <DashboardPage
                  pendingProposals={socket.pendingProposals}
                  proposals={proposals}
                  outcomes={outcomes}
                  totalCostUsd={status?.totalCostUsd ?? 0}
                  feed={socket.feed}
                  onOpenLiveFeed={() => navigate(PAGE_PATHS.live)}
                />
              }
            />
            <Route path="/live" element={<LiveFeedPage feed={socket.feed} />} />
            <Route path="/proposals" element={<ProposalsPage proposals={proposals} outcomes={outcomes} />} />
            <Route
              path="/actions"
              element={
                <ActionsPage
                  historyVersion={socket.historyVersion}
                  proposals={proposals}
                  outcomes={outcomes}
                  onSetReview={setProposalReview}
                />
              }
            />
            <Route path="/lessons" element={<LessonsPage historyVersion={socket.historyVersion} />} />
            <Route path="/research" element={<ResearchPage historyVersion={socket.historyVersion} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}

export default App
