import { Alert, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { EyeOutlined, DatabaseOutlined, WarningOutlined } from '@ant-design/icons'
import type { ToolRisk } from '../types'
import { useToolCatalog } from '../hooks/useToolCatalog'

const RISK_META: Record<ToolRisk, { color: string; icon: React.ReactNode; hint: string }> = {
  write: {
    color: 'error',
    icon: <WarningOutlined />,
    hint: 'Side-effecting — creates, commits, or deploys something real that outlives this run.',
  },
  read: { color: 'default', icon: <EyeOutlined />, hint: 'Read-only — fetches information, changes nothing.' },
  memory: { color: 'blue', icon: <DatabaseOutlined />, hint: "Writes only to the agent's own memory database." },
  unknown: { color: 'warning', icon: <WarningOutlined />, hint: 'Not in the tool catalog — it will never match a real tool.' },
}

export function ToolTag({ name, risk }: { name: string; risk: ToolRisk }) {
  const meta = RISK_META[risk]
  return (
    <Tooltip title={meta.hint}>
      <Tag color={meta.color} icon={meta.icon} className="mono" style={{ marginBottom: 4 }}>
        {name.replace(/^mcp__(memory|integrations)__/, '')}
      </Tag>
    </Tooltip>
  )
}

/**
 * The list of tools an approved proposal would be fenced to, with each one's blast radius
 * made visible. In edit mode the operator can narrow that list (or widen it, within the
 * catalog) before approving — `required_tools` *is* the fence, so this is the main lever for
 * saying "yes, but not with that" instead of rejecting outright.
 */
export function ToolFence({
  tools,
  editable = false,
  onChange,
}: {
  tools: string[]
  editable?: boolean
  onChange?: (next: string[]) => void
}) {
  const catalog = useToolCatalog()
  const riskOf = (name: string): ToolRisk => catalog.get(name) ?? (catalog.size === 0 ? 'read' : 'unknown')
  const writeCount = tools.filter((t) => riskOf(t) === 'write').length
  // Only meaningful once the catalog has loaded; before that everything looks unknown.
  const unknownTools = catalog.size === 0 ? [] : tools.filter((t) => !catalog.has(t))

  return (
    <div>
      <Space align="center" size={8} style={{ marginBottom: 4 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          TOOLS REQUIRED
        </Typography.Text>
        {catalog.size > 0 && writeCount > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            · {writeCount} side-effecting
          </Typography.Text>
        )}
      </Space>

      {editable ? (
        <>
          <Select
            // `tags` rather than `multiple`: the catalog is the suggestion list, not the
            // limit. A name the console doesn't know about can still be entered — the
            // catalog may predate a tool the backend just gained, and an entry that
            // matches nothing can't grant anything, so it's flagged rather than blocked.
            mode="tags"
            style={{ width: '100%' }}
            value={tools}
            onChange={(next: string[]) => onChange?.(next.map((t) => t.trim()).filter(Boolean))}
            placeholder="No tools — the act phase could create, commit or deploy nothing"
            options={[...catalog.entries()].map(([name, risk]) => ({
              value: name,
              label: `${name.replace(/^mcp__(memory|integrations)__/, '')}${risk === 'write' ? '  ⚠ side-effecting' : ''}`,
            }))}
            optionFilterProp="label"
            tokenSeparators={[',']}
          />
          {unknownTools.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message={`${unknownTools.length} name${unknownTools.length === 1 ? " isn't" : "s aren't"} in the tool catalog.`}
              description={`${unknownTools.join(', ')} — the act phase matches tools by exact name, so ${
                unknownTools.length === 1 ? 'this one grants' : 'these grant'
              } nothing. Harmless, but check for a typo.`}
            />
          )}
          {writeCount > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message={`Approving grants ${writeCount} side-effecting tool${writeCount === 1 ? '' : 's'}.`}
              description="Removing one here narrows what the act phase can do. It cannot create, commit or deploy anything not in this list."
            />
          )}
        </>
      ) : (
        <div style={{ marginTop: 4 }}>
          {tools.length === 0 ? (
            <Typography.Text type="secondary">none</Typography.Text>
          ) : (
            tools.map((t) => <ToolTag key={t} name={t} risk={riskOf(t)} />)
          )}
        </div>
      )}
    </div>
  )
}
