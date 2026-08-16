import { useEffect, useMemo, useState } from 'react'
import { App, Alert, Button, Card, Collapse, Input, InputNumber, Select, Space, Tag, Tooltip, Typography } from 'antd'
import type { ProviderInfo, SettingView, SettingsResponse } from '../types'
import { api } from '../api'
import { palette } from '../theme'

/**
 * Settings that used to need a .env edit and a restart.
 *
 * Entirely driven off what the server sends -- label, help, type, range, options and the
 * source of the current value all come from the registry in `src/settings.ts`, so adding a
 * setting there needs no change here.
 *
 * Two things this page has to be honest about, and both come from the server:
 *
 *  - **Where a value came from.** Once a saved value beats `.env`, "I edited .env and nothing
 *    happened" becomes the confusing failure. Every field says whether it is reading the
 *    database, the environment, or a built-in default.
 *  - **Which providers actually have a key.** API keys deliberately never moved into the
 *    database, so a provider can be perfectly valid and still unusable. Selecting one whose
 *    key is missing is refused on save, and the option says so before you try.
 */

const SOURCE_TAG: Record<SettingView['source'], { color: string; label: string; hint: string }> = {
  database: { color: 'success', label: 'saved', hint: 'Set from this console. Overrides the .env value.' },
  environment: { color: 'default', label: '.env', hint: 'Read from .env — this console has never set it.' },
  default: { color: 'default', label: 'default', hint: 'Neither .env nor this console has set it.' },
}

const GROUP_TITLES: Record<SettingView['group'], { title: string; blurb: string }> = {
  loop: { title: 'Research loop', blurb: 'How much work the agent queues up for you.' },
  search: { title: 'Web search', blurb: 'How WebSearch is performed. Tavily and Brave keys stay in .env.' },
  model: {
    title: 'Models',
    blurb:
      'Which model each phase runs on. Changes apply from the next phase — a cycle already in flight ' +
      'finishes on the model it started with. Provider API keys stay in .env.',
  },
}

function SourceTag({ source }: { source: SettingView['source'] }) {
  const meta = SOURCE_TAG[source]
  return (
    <Tooltip title={meta.hint}>
      <Tag color={meta.color} style={{ marginInlineEnd: 0, fontSize: 11 }}>
        {meta.label}
      </Tag>
    </Tooltip>
  )
}

function SettingField({
  setting,
  value,
  providers,
  onChange,
}: {
  setting: SettingView
  value: string | number
  providers: ProviderInfo[]
  onChange: (next: string | number) => void
}) {
  const isProvider = setting.key.toLowerCase().includes('provider') && setting.group === 'model'
  const providerInfo = isProvider ? providers.find((p) => p.id === value) : undefined

  let control
  if (setting.type === 'integer') {
    control = (
      <InputNumber
        min={setting.min}
        max={setting.max}
        value={value as number}
        onChange={(next) => next !== null && onChange(next)}
        style={{ width: 160 }}
      />
    )
  } else if (setting.type === 'enum') {
    const options = (setting.options ?? []).map((option) => {
      const provider = isProvider ? providers.find((p) => p.id === option) : undefined
      return {
        value: option,
        // The key state is on the option itself, so it's visible while choosing rather than
        // only in the error after saving.
        label: provider ? `${provider.label}${provider.hasKey ? '' : `  ·  no ${provider.apiKeyEnv}`}` : option,
      }
    })
    control = (
      <Select
        style={{ width: 280 }}
        value={value as string}
        onChange={onChange}
        options={setting.allowsEmpty ? [{ value: '', label: 'inherit base setting' }, ...options] : options}
      />
    )
  } else {
    control = (
      <Input
        style={{ width: 320 }}
        className="mono"
        value={value as string}
        placeholder={setting.allowsEmpty ? 'inherit base setting' : 'e.g. anthropic/claude-opus-5'}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <Space align="center" size={8} style={{ marginBottom: 4 }}>
        <Typography.Text strong>{setting.label}</Typography.Text>
        <SourceTag source={setting.source} />
        <Tooltip title={`Seeds from ${setting.envVar} in .env`}>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
            {setting.envVar}
          </Typography.Text>
        </Tooltip>
      </Space>
      <div>{control}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4, maxWidth: 640 }}>
        {setting.help}
      </Typography.Text>
      {providerInfo && !providerInfo.hasKey && (
        <Typography.Text style={{ fontSize: 12, color: palette.rejected }}>
          {providerInfo.apiKeyEnv} is not set in .env — saving this will be refused.
        </Typography.Text>
      )}
      {providerInfo?.hasKey && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          <a href={providerInfo.modelsUrl} target="_blank" rel="noreferrer">
            {providerInfo.label} model list
          </a>
        </Typography.Text>
      )}
    </div>
  )
}

export function SettingsPage() {
  const { message } = App.useApp()
  const [data, setData] = useState<SettingsResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, string | number>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .settings()
      .then(setData)
      .catch(() => setData(null))
  }, [])

  // Memoized on `data` so the `dirty` diff below doesn't recompute on every keystroke:
  // `data?.settings ?? []` would be a fresh array each render.
  const settings = useMemo(() => data?.settings ?? [], [data])
  const valueOf = (setting: SettingView) => draft[setting.key] ?? setting.value

  // Only what actually differs is sent: the server applies a patch atomically, and sending
  // every field would make an unrelated invalid value block an unrelated valid edit.
  const dirty = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(draft).filter(([key, value]) => settings.find((s) => s.key === key)?.value !== value),
      ),
    [draft, settings],
  )
  const dirtyCount = Object.keys(dirty).length

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const { settings: next } = await api.saveSettings(dirty)
      setData((prev) => (prev ? { ...prev, settings: next } : prev))
      setDraft({})
      message.success(`Saved ${dirtyCount} setting${dirtyCount === 1 ? '' : 's'}`)
    } catch (err) {
      // The server's message is the useful one — it names the provider key that's missing, or
      // the range that was exceeded. Shown inline rather than as a toast that scrolls away.
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!data) {
    return <Alert type="warning" message="Settings unavailable — is the agent process running?" />
  }

  const groups: SettingView['group'][] = ['loop', 'search', 'model']
  const baseModelSettings = settings.filter(
    (s) => s.group === 'model' && (s.key === 'llmProvider' || s.key === 'llmModel'),
  )
  const overrideSettings = settings.filter(
    (s) => s.group === 'model' && s.key !== 'llmProvider' && s.key !== 'llmModel',
  )

  const field = (setting: SettingView) => (
    <SettingField
      key={setting.key}
      setting={setting}
      value={valueOf(setting)}
      providers={data.providers}
      onChange={(next) => setDraft((prev) => ({ ...prev, [setting.key]: next }))}
    />
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="API keys and secrets stay in .env"
        description={
          'Provider keys, GITHUB_TOKEN and the connector keys are deliberately not stored in the database — ' +
          'a leaked agent.db (or one of the .bak files next to it) would otherwise cost you a live credential, ' +
          'not just the agent’s memory. The database path, port, bind host and API token stay there too: ' +
          'the database has to be readable before any of this can be read out of it.'
        }
      />

      {error && <Alert type="error" showIcon message="Nothing was saved" description={error} closable onClose={() => setError(null)} />}

      {groups.map((group) => {
        const inGroup = group === 'model' ? baseModelSettings : settings.filter((s) => s.group === group)
        if (inGroup.length === 0) return null
        return (
          <Card key={group} size="small" title={GROUP_TITLES[group].title}>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {GROUP_TITLES[group].blurb}
            </Typography.Paragraph>
            {inGroup.map(field)}

            {group === 'search' && !data.searchKeys.tavily && !data.searchKeys.brave && (
              <Alert
                type="warning"
                showIcon
                message="No search API key is set"
                description="Only 'native' and 'none' will work. Set TAVILY_API_KEY or BRAVE_API_KEY in .env for the others."
              />
            )}

            {group === 'model' && (
              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'overrides',
                    label: `Per-phase overrides (${overrideSettings.filter((s) => s.value !== '').length} set)`,
                    children: (
                      <>
                        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                          The phases want different things: research is long and wide, act writes real code with no
                          build step to catch a mistake, reflect is two short memory calls. Anything left empty
                          inherits the base provider and model above.
                        </Typography.Paragraph>
                        {overrideSettings.map(field)}
                      </>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        )
      })}

      <Space>
        <Button type="primary" disabled={dirtyCount === 0} loading={saving} onClick={save}>
          {dirtyCount === 0 ? 'No changes' : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
        </Button>
        {dirtyCount > 0 && (
          <Button onClick={() => setDraft({})} disabled={saving}>
            Discard
          </Button>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Saved together, or not at all — if any value is rejected, none of them apply.
        </Typography.Text>
      </Space>
    </Space>
  )
}
