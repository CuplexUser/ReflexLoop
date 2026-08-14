import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result, Typography } from 'antd'

interface State {
  error: Error | null
}

/**
 * Keeps a render error in one page from blanking the whole console — the live feed and the
 * pending-review queue are the point of this UI, and losing them to a bad row somewhere is worse
 * than showing the error in place.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <Result
        status="error"
        title="Something broke rendering this page"
        subTitle={
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
            {this.state.error.message}
          </Typography.Text>
        }
        extra={[
          <Button key="retry" type="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>,
          <Button key="reload" onClick={() => window.location.reload()}>
            Reload
          </Button>,
        ]}
      />
    )
  }
}
