import { Button, Checkbox, Dropdown, Segmented, Space, Tooltip } from 'antd'
import { ColumnHeightOutlined, DownloadOutlined, SettingOutlined } from '@ant-design/icons'
import type { TableViewControls } from '../hooks/useTableView'

/**
 * The chrome every table page shares: column show/hide, row density, and export of exactly
 * the rows currently on screen. Kept as one component so the six tables can't drift into six
 * slightly different toolbars.
 */
export function TableToolbar({
  view,
  onExportCsv,
  onExportJson,
  extra,
}: {
  view: TableViewControls
  onExportCsv?: () => void
  onExportJson?: () => void
  extra?: React.ReactNode
}) {
  const hiddenCount = view.hiddenColumns.length

  return (
    <Space size={8} wrap>
      {extra}

      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            ...view.allColumns.map((col) => ({
              key: col.key,
              label: (
                <Checkbox
                  checked={!view.hiddenColumns.includes(col.key)}
                  onChange={(e) => view.toggleColumn(col.key, e.target.checked)}
                >
                  {col.title}
                </Checkbox>
              ),
            })),
            { type: 'divider' as const },
            {
              key: '__all',
              label: 'Show all columns',
              disabled: hiddenCount === 0,
              onClick: view.showAllColumns,
            },
          ],
        }}
      >
        <Button icon={<SettingOutlined />}>Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}</Button>
      </Dropdown>

      <Tooltip title="Row height">
        <Segmented
          value={view.density}
          onChange={(v) => view.setDensity(v as typeof view.density)}
          options={[
            { value: 'small', icon: <ColumnHeightOutlined />, title: 'Compact' },
            { value: 'middle', label: 'Default' },
            { value: 'large', label: 'Roomy' },
          ]}
        />
      </Tooltip>

      {(onExportCsv || onExportJson) && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              ...(onExportCsv ? [{ key: 'csv', label: 'Export CSV', onClick: onExportCsv }] : []),
              ...(onExportJson ? [{ key: 'json', label: 'Export JSON', onClick: onExportJson }] : []),
            ],
          }}
        >
          <Button icon={<DownloadOutlined />}>Export</Button>
        </Dropdown>
      )}
    </Space>
  )
}
