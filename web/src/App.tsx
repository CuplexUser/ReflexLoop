import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { App as AntApp, Badge, Button, Layout, Menu, Tooltip, Typography } from 'antd'
import {
  BulbOutlined,
  CodeOutlined,
  ControlOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FundOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAgentSocket } from './useAgentSocket'
import { UnauthorizedError, api } from './api'
import { getToken } from './auth'
import { StatusBar } from './components/StatusBar'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TokenGate } from './components/TokenGate'
import { DashboardPage } from './pages/DashboardPage'
import { LiveFeedPage } from './pages/LiveFeedPage'
import { ProposalsPage } from './pages/ProposalsPage'
import { ActionsPage } from './pages/ActionsPage'
import { LessonsPage } from './pages/LessonsPage'
import { ResearchPage } from './pages/ResearchPage'
import { EconomicsPage } from './pages/EconomicsPage'
import { ControlPage } from './pages/ControlPage'
import type { ThemeMode } from './theme'
import type { OutcomeRow, ProposalRow, StatusResponse } from './types'

type PageKey = 'dashboard' | 'live' | 'proposals' | 'actions' | 'economics' | 'lessons' | 'research' | 'control'

/** Nav key -> the path its menu item goes to. Routes below also accept a trailing /:id for deep links. */
const PAGE_PATHS: Record<PageKey, string> = {
  dashboard: '/',
  live: '/live',
  proposals: '/proposals',
  actions: '/actions',
  economics: '/economics',
  lessons: '/lessons',
  research: '/research',
  control: '/control',
}

function App({ themeMode, onToggleTheme }: { themeMode: ThemeMode; onToggleTheme: () => void }) {
  const { message } = AntApp.useApp()
  const socket = useAgentSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [proposals, setProposals] = useState<ProposalRow[]>([])
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [needsToken, setNeedsToken] = useState(false)
  const [authVersion, setAuthVersion] = useState(0)

  // The first path segment picks the nav item, so /proposals/12 still highlights Proposals.
  const segment = `/${location.pathname.split('/')[1] ?? ''}`
  const page = (Object.keys(PAGE_PATHS) as PageKey[]).find((key) => PAGE_PATHS[key] === segment) ?? 'dashboard'

  useEffect(() => {
    Promise.all([api.status(), api.proposals(), api.outcomes()])
      .then(([s, p, o]) => {
        setStatus(s)
        setProposals(p)
        setOutcomes(o)
        setNeedsToken(false)
      })
      .catch((err) => {
        // A 401 means the backend wants a token we don't have; anything else is transient
        // (a backend restart), and the next historyVersion bump retries.
        if (err instanceof UnauthorizedError) setNeedsToken(true)
      })
  }, [socket.historyVersion, authVersion])

  // Cmd-K / Ctrl-K anywhere opens search; Escape closes it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const pendingCount = Math.max(proposals.filter((p) => p.status === 'pending').length, socket.pendingProposals.length)

  const setProposalReview = useCallback(
    async (id: number, reviewStatus: ProposalRow['review_status']) => {
      try {
        await api.setProposalReview(id, reviewStatus)
        setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, review_status: reviewStatus } : p)))
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Review update failed')
      }
    },
    [message],
  )

  if (needsToken && !getToken()) {
    return <TokenGate onSubmit={() => setAuthVersion((v) => v + 1)} />
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
            { key: 'economics', icon: <FundOutlined />, label: 'Economics' },
            { key: 'lessons', icon: <BulbOutlined />, label: 'Lessons' },
            { key: 'research', icon: <ExperimentOutlined />, label: 'Research notes' },
            { key: 'control', icon: <ControlOutlined />, label: 'Agent control' },
          ]}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 24 }}>
          <StatusBar
            connection={socket.connection}
            domains={socket.domains.length > 0 ? socket.domains : (status?.domains ?? [])}
            runningPhase={socket.runningPhase}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Tooltip title="Search everything (Cmd-K)">
              <Button icon={<SearchOutlined />} onClick={() => setPaletteOpen(true)}>
                Search
              </Button>
            </Tooltip>
            <Tooltip title={themeMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              <Button
                icon={themeMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={onToggleTheme}
                aria-label="Toggle theme"
              />
            </Tooltip>
          </div>
        </Layout.Header>

        <Layout.Content style={{ margin: 24 }}>
          <ErrorBoundary>
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
              <Route path="/proposals/:id" element={<ProposalsPage proposals={proposals} outcomes={outcomes} />} />
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
              <Route
                path="/actions/:id"
                element={
                  <ActionsPage
                    historyVersion={socket.historyVersion}
                    proposals={proposals}
                    outcomes={outcomes}
                    onSetReview={setProposalReview}
                  />
                }
              />
              <Route
                path="/economics"
                element={<EconomicsPage historyVersion={socket.historyVersion} outcomes={outcomes} />}
              />
              <Route path="/lessons" element={<LessonsPage historyVersion={socket.historyVersion} />} />
              <Route path="/lessons/:id" element={<LessonsPage historyVersion={socket.historyVersion} />} />
              <Route path="/research" element={<ResearchPage historyVersion={socket.historyVersion} />} />
              <Route path="/research/:id" element={<ResearchPage historyVersion={socket.historyVersion} />} />
              <Route path="/control" element={<ControlPage historyVersion={socket.historyVersion} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </Layout.Content>
      </Layout>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Layout>
  )
}

export default App
