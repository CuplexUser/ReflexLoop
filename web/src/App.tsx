import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { App as AntApp, Badge, Button, Layout, Menu, Spin, Tag, Tooltip, Typography } from 'antd'
import {
  BulbOutlined,
  CodeOutlined,
  AimOutlined,
  ControlOutlined,
  SettingOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FundOutlined,
  MoonOutlined,
  RocketOutlined,
  SearchOutlined,
  SunOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAgentSocket } from './useAgentSocket'
import { UnauthorizedError, api } from './api'
import { getToken } from './auth'
import { StatusBar } from './components/StatusBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TokenGate } from './components/TokenGate'
import { ConsoleOnlyContext, READ_ONLY_HINT } from './consoleOnly'
import { DashboardPage } from './pages/DashboardPage'
import { palette, type ThemeMode } from './theme'
import type { OutcomeRow, ProposalRow, StatusResponse } from './types'

/**
 * Every route except the landing Dashboard is loaded on demand, so opening the console pulls
 * down the shell plus one page instead of all eight and every dialog they own. The pages use
 * named exports, hence the `.then` unwrap — `lazy` wants a module with a `default`.
 *
 * Dashboard stays eagerly imported: it is what `/` renders, and making it dynamic would only
 * add a request round-trip in front of the first paint.
 */
const LiveFeedPage = lazy(() => import('./pages/LiveFeedPage').then((m) => ({ default: m.LiveFeedPage })))
const ProposalsPage = lazy(() => import('./pages/ProposalsPage').then((m) => ({ default: m.ProposalsPage })))
const ActionsPage = lazy(() => import('./pages/ActionsPage').then((m) => ({ default: m.ActionsPage })))
const DeliverablesPage = lazy(() => import('./pages/DeliverablesPage').then((m) => ({ default: m.DeliverablesPage })))
const LessonsPage = lazy(() => import('./pages/LessonsPage').then((m) => ({ default: m.LessonsPage })))
const ResearchPage = lazy(() => import('./pages/ResearchPage').then((m) => ({ default: m.ResearchPage })))
const EconomicsPage = lazy(() => import('./pages/EconomicsPage').then((m) => ({ default: m.EconomicsPage })))
const ControlPage = lazy(() => import('./pages/ControlPage').then((m) => ({ default: m.ControlPage })))
const GoalsPage = lazy(() => import('./pages/GoalsPage').then((m) => ({ default: m.GoalsPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

// Only mounts on Cmd-K, so its modal + search plumbing has no business in the initial payload.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))

type PageKey =
  | 'dashboard'
  | 'live'
  | 'proposals'
  | 'deliverables'
  | 'actions'
  | 'economics'
  | 'lessons'
  | 'research'
  | 'goals'
  | 'control'
  | 'settings'

/** Nav key -> the path its menu item goes to. Routes below also accept a trailing /:id for deep links. */
const PAGE_PATHS: Record<PageKey, string> = {
  dashboard: '/',
  live: '/live',
  proposals: '/proposals',
  deliverables: '/deliverables',
  actions: '/actions',
  economics: '/economics',
  lessons: '/lessons',
  research: '/research',
  goals: '/goals',
  control: '/control',
  settings: '/settings',
}

/** Shown for the moment a lazily-loaded page's chunk is in flight. */
function PageFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
      <Spin size="large" />
    </div>
  )
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
  // Flips on the first Cmd-K and never back, so the palette chunk is fetched once and the modal
  // stays mounted afterwards — closing it keeps its exit animation instead of unmounting mid-fade.
  const [paletteEverOpened, setPaletteEverOpened] = useState(false)
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

  useEffect(() => {
    if (paletteOpen) setPaletteEverOpened(true)
  }, [paletteOpen])

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
    <ConsoleOnlyContext.Provider value={status?.consoleOnly ?? false}>
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={220} breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: '20px 24px 12px' }}>
          <Typography.Title level={5} style={{ margin: 0, color: palette.textPrimary }}>
            agent-runner
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            operator console
          </Typography.Text>
        </div>
        <Menu
          // The sider is `bgSunken`, which follows the mode -- so the menu has to as well, or
          // its light-on-dark text ends up light-on-light.
          theme={themeMode}
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
            { key: 'deliverables', icon: <RocketOutlined />, label: 'Deliverables' },
            { key: 'actions', icon: <ThunderboltOutlined />, label: 'Actions' },
            { key: 'economics', icon: <FundOutlined />, label: 'Economics' },
            { key: 'lessons', icon: <BulbOutlined />, label: 'Lessons' },
            { key: 'research', icon: <ExperimentOutlined />, label: 'Research notes' },
            { key: 'goals', icon: <AimOutlined />, label: 'Goals' },
            { key: 'control', icon: <ControlOutlined />, label: 'Agent control' },
            { key: 'settings', icon: <SettingOutlined />, label: 'Settings' },
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
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {status?.consoleOnly && (
              // Sits in the header rather than on the page, because it is true of every page:
              // whichever one you're on, its write controls are disabled and this says why.
              <Tooltip title={READ_ONLY_HINT}>
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  read-only console
                </Tag>
              </Tooltip>
            )}
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
            <Suspense fallback={<PageFallback />}>
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
                  path="/deliverables"
                  element={
                    <DeliverablesPage
                      historyVersion={socket.historyVersion}
                      proposals={proposals}
                      onSetReview={setProposalReview}
                    />
                  }
                />
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
                <Route path="/goals" element={<GoalsPage />} />
                <Route path="/goals/:id" element={<GoalsPage />} />
                  <Route path="/control" element={<ControlPage historyVersion={socket.historyVersion} />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </Layout.Content>
      </Layout>

      {paletteEverOpened && (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
    </Layout>
    </ConsoleOnlyContext.Provider>
  )
}

export default App
