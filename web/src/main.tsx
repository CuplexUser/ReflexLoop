import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { buildAntdTheme, type ThemeMode } from './theme.ts'

// Also read by the inline script in index.html, which stamps data-theme before first paint so
// light-theme users don't get a flash of dark. Change both together.
const STORAGE_KEY = 'reflexloop:theme'

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // storage blocked -- fall through to the OS preference
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function Root() {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode)

  // The attribute is what index.css keys the --rl-* variables off, so components reading
  // `palette` follow the theme without re-rendering.
  useEffect(() => {
    document.documentElement.dataset.theme = mode
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // preference just won't persist
    }
  }, [mode])

  return (
    <ConfigProvider theme={buildAntdTheme(mode)}>
      <AntApp>
        <BrowserRouter>
          <App themeMode={mode} onToggleTheme={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))} />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
