import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Input, Radio, Select, Space, Tag, Tooltip, Typography, message } from 'antd'
import type { ControlState } from '../types'
import { api } from '../api'
import { READ_ONLY_HINT, useConsoleOnly } from '../consoleOnly'

/**
 * Steering the loop from the monetization section, seeded by what the section just showed.
 *
 * The section exists to surface things an operator would want to act on — a revenue model that
 * never converts, a deadline the agent set itself and missed. Reading that with no way to respond
 * makes it a report rather than a control, and the response almost always concerns the *next*
 * proposals rather than any one that already exists (which the review flow already handles, with a
 * reason that becomes a lesson).
 *
 * Both levers here only redirect what the agent *researches*. Neither approves a proposal nor
 * widens the act-phase fence — a "make this happen" button would break the invariant the rest of
 * the design assumes, so the strongest thing on this card is a sentence handed to a prompt.
 *
 * The two differ in how long they last, which is a real choice and so is made explicit rather than
 * picked silently:
 *   - directive: injected into one research prompt, then cleared. A one-shot steer that survived
 *     being consumed would quietly become standing instruction nobody remembers setting.
 *   - goal brief: passed verbatim every cycle until edited. Operator instructions belong here —
 *     the title is only the grouping key.
 */

export interface SteerSeed {
  /** Which block on the page produced this, e.g. "Pathways". */
  source: string
  /** Short button text. */
  label: string
  /** What lands in the textarea. */
  text: string
}

type Lifetime = 'once' | 'standing'

export function MonetizationSteer({
  seeds,
  historyVersion,
}: {
  seeds: SteerSeed[]
  historyVersion: number
}) {
  const consoleOnly = useConsoleOnly()
  const [control, setControl] = useState<ControlState | null>(null)
  const [text, setText] = useState('')
  const [lifetime, setLifetime] = useState<Lifetime>('once')
  const [goalId, setGoalId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    api
      .control()
      .then(setControl)
      .catch(() => setControl(null))
  }, [])

  useEffect(refresh, [refresh, historyVersion])

  // Only active goals can carry a standing instruction: suggested ones are inert until accepted,
  // and retired ones are never put in a prompt, so appending to either writes text nothing reads.
  const goals = useMemo(
    () => (control?.goals ?? []).filter((g) => g.status === 'active'),
    [control?.goals],
  )

  useEffect(() => {
    if (goalId === null && goals.length > 0) setGoalId(goals[0].id)
  }, [goalId, goals])

  // The directive route needs a research loop, which console-only mode has none of, so it is off
  // the server's allowlist. Goal writes are on it — hence two different disabled states rather
  // than one blanket one, or half this card would fail after the click instead of before it.
  const directiveBlocked = consoleOnly && lifetime === 'once'
  const canSend = text.trim().length > 0 && !saving && !directiveBlocked &&
    (lifetime === 'once' || goalId !== null)

  async function send() {
    const instruction = text.trim()
    if (!instruction) return
    setSaving(true)
    try {
      if (lifetime === 'once') {
        await api.setDirective(instruction)
        message.success('Directive queued for the next research cycle')
      } else {
        const goal = goals.find((g) => g.id === goalId)
        if (!goal) return
        const brief = goal.brief.trim()
        await api.updateGoal(goal.id, { brief: brief ? `${brief}\n\n${instruction}` : instruction })
        message.success(`Added to the brief for "${goal.title}"`)
      }
      setText('')
      refresh()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Could not save the steer')
    } finally {
      setSaving(false)
    }
  }

  async function clearDirective() {
    setSaving(true)
    try {
      await api.setDirective(null)
      message.success('Queued directive cleared')
      refresh()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Could not clear the directive')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      size="small"
      title="Steer the agent"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          redirects research only — never approves or widens scope
        </Typography.Text>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {control?.directive && (
          <Alert
            type="warning"
            showIcon
            message="A directive is already queued"
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text style={{ fontSize: 13 }}>{control.directive}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  It will be injected into the next research prompt and then cleared. Sending another
                  replaces it.
                </Typography.Text>
                <Button size="small" onClick={clearDirective} disabled={saving || consoleOnly}>
                  Clear it
                </Button>
              </Space>
            }
          />
        )}

        {seeds.length > 0 && (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              SEED FROM A FINDING ON THIS PAGE
            </Typography.Text>
            <Space size={8} wrap>
              {seeds.map((seed) => (
                <Tooltip key={seed.label} title={seed.text}>
                  <Button size="small" onClick={() => setText(seed.text)}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {seed.source} ·{' '}
                    </Typography.Text>
                    <span style={{ fontSize: 12 }}>{seed.label}</span>
                  </Button>
                </Tooltip>
              ))}
            </Space>
          </Space>
        )}

        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Type a steer, or pick a seed above…"
        />

        <Space size={12} wrap align="center">
          <Radio.Group value={lifetime} onChange={(e) => setLifetime(e.target.value as Lifetime)}>
            <Radio.Button value="once">Next cycle only</Radio.Button>
            <Radio.Button value="standing">Standing instruction</Radio.Button>
          </Radio.Group>

          {lifetime === 'standing' && (
            <Select
              value={goalId ?? undefined}
              onChange={setGoalId}
              style={{ minWidth: 240 }}
              placeholder="Which goal?"
              options={goals.map((g) => ({ value: g.id, label: g.title }))}
              notFoundContent="No active goals"
            />
          )}

          <Tooltip title={directiveBlocked ? READ_ONLY_HINT : undefined}>
            <Button type="primary" onClick={send} loading={saving} disabled={!canSend}>
              {lifetime === 'once' ? 'Queue for next cycle' : 'Add to goal brief'}
            </Button>
          </Tooltip>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {lifetime === 'once' ? (
            <>
              Injected into one research prompt, then cleared — a nudge, not a standing rule. Takes
              effect on the next cycle, with no restart.
              {consoleOnly && (
                <>
                  {' '}
                  <Tag color="default">unavailable in read-only console</Tag>
                </>
              )}
            </>
          ) : (
            <>
              Appended to the goal's brief, which is passed verbatim to research every cycle until you
              edit it again. This is where operator instructions belong — the title is only the key.
            </>
          )}
        </Typography.Text>
      </Space>
    </Card>
  )
}
