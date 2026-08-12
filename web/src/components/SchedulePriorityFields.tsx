import { useEffect, useState } from 'react'
import { DatePicker, InputNumber, Radio, Select, Space, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { Priority } from '../types'
import type { ScheduleOptions } from '../api'

type Mode = 'now' | 'at' | 'repeating'
type RecurrencePreset = 'hourly' | '6h' | 'daily' | 'weekly' | 'custom'

const RECURRENCE_MS: Record<Exclude<RecurrencePreset, 'custom'>, number> = {
  hourly: 3_600_000,
  '6h': 6 * 3_600_000,
  daily: 24 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
}

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

const RECURRENCE_OPTIONS: { value: RecurrencePreset; label: string }[] = [
  { value: 'hourly', label: 'Every hour' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'custom', label: 'Custom' },
]

/** Priority + "run now / at a time / repeating" controls, shared by both approve surfaces. Reports its current value via onChange. */
export function SchedulePriorityFields({ onChange }: { onChange: (schedule: ScheduleOptions) => void }) {
  const [priority, setPriority] = useState<Priority>('normal')
  const [mode, setMode] = useState<Mode>('now')
  const [scheduledAt, setScheduledAt] = useState<Dayjs | null>(null)
  const [recurrencePreset, setRecurrencePreset] = useState<RecurrencePreset>('daily')
  const [customHours, setCustomHours] = useState(1)

  useEffect(() => {
    const recurrenceMs =
      mode === 'repeating'
        ? (recurrencePreset === 'custom' ? Math.round(customHours * 3_600_000) : RECURRENCE_MS[recurrencePreset])
        : null
    const effectiveScheduledAt = mode === 'now' ? null : (scheduledAt?.toISOString() ?? null)
    onChange({ priority, scheduledAt: effectiveScheduledAt, recurrenceMs })
  }, [priority, mode, scheduledAt, recurrencePreset, customHours, onChange])

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space align="center" size={8}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          PRIORITY
        </Typography.Text>
        <Select size="small" style={{ width: 110 }} value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} />
      </Space>

      <Radio.Group size="small" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <Radio.Button value="now">Run now</Radio.Button>
        <Radio.Button value="at">At a time</Radio.Button>
        <Radio.Button value="repeating">Repeating</Radio.Button>
      </Radio.Group>

      {mode === 'at' && (
        <DatePicker
          showTime
          size="small"
          value={scheduledAt}
          onChange={setScheduledAt}
          disabledDate={(d) => d.isBefore(dayjs(), 'minute')}
          placeholder="Run at…"
        />
      )}

      {mode === 'repeating' && (
        <Space size={8} wrap>
          <DatePicker showTime size="small" value={scheduledAt} onChange={setScheduledAt} placeholder="First run (defaults to now)" />
          <Select
            size="small"
            style={{ width: 140 }}
            value={recurrencePreset}
            onChange={setRecurrencePreset}
            options={RECURRENCE_OPTIONS}
          />
          {recurrencePreset === 'custom' && (
            <InputNumber size="small" min={0.1} step={0.5} value={customHours} onChange={(v) => setCustomHours(v ?? 1)} addonAfter="hours" />
          )}
        </Space>
      )}
    </Space>
  )
}
