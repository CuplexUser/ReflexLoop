export function money(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

export function preview(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const s = Math.round(diffMs / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

/** Same idea as timeAgo but for a future timestamp, e.g. a proposal's next_run_at. */
export function inWords(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return 'due now'
  const s = Math.round(diffMs / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h}h`
  const d = Math.round(h / 24)
  return `in ${d}d`
}

/** Short human label for a recurrence interval, e.g. "every 6h", "daily", "weekly". */
export function recurrenceLabel(ms: number): string {
  const hours = ms / 3_600_000
  if (hours === 24) return 'daily'
  if (hours === 24 * 7) return 'weekly'
  if (hours === 1) return 'hourly'
  if (hours < 1) return `every ${Math.round(ms / 60_000)}m`
  return `every ${hours % 1 === 0 ? hours : hours.toFixed(1)}h`
}

export const PRIORITY_LABEL: Record<'low' | 'normal' | 'high' | 'urgent', string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export const PRIORITY_TAG_COLOR: Record<'low' | 'normal' | 'high' | 'urgent', string> = {
  low: 'default',
  normal: 'blue',
  high: 'orange',
  urgent: 'red',
}

export const PHASE_LABEL: Record<string, string> = {
  research_plan: 'Research + Plan',
  act: 'Act',
  reflect: 'Reflect',
}

const ACTION_LABEL: Record<string, string> = {
  github_read_repo: 'Read repo',
  github_read_file: 'Read file',
  github_search_repos: 'Search repos',
  github_create_repo: 'Create repo',
  github_create_branch: 'Create branch',
  github_commit_file: 'Commit file',
  github_create_pr: 'Open PR',
  vercel_list_projects: 'List projects',
  vercel_get_project: 'Get project',
  vercel_deploy: 'Deploy',
  netlify_list_sites: 'List sites',
  netlify_get_site: 'Get site',
  netlify_create_site: 'Create site',
  netlify_deploy: 'Deploy',
  WebSearch: 'Web search',
  WebFetch: 'Web fetch',
}

function shortToolName(toolName: string): string {
  return toolName.replace(/^mcp__(memory|integrations)__/, '')
}

/** Short, human "type of action" label for a tool call, e.g. "Create repo". */
export function actionLabel(toolName: string): string {
  const short = shortToolName(toolName)
  return ACTION_LABEL[short] ?? short.replace(/_/g, ' ')
}

/** One-line description filled in from the tool's actual input, e.g. `"my-repo" — a landing page`. */
export function actionDescription(toolName: string, inputRaw: string | null): string {
  const short = shortToolName(toolName)
  let input: Record<string, unknown> = {}
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {}
  } catch {
    // fall through to the raw-preview default below
  }

  switch (short) {
    case 'github_read_repo':
    case 'github_read_file':
      return `${input.owner}/${input.repo}${input.path ? `: ${input.path}` : ''}`
    case 'github_search_repos':
      return String(input.query ?? '')
    case 'github_create_repo':
      return `"${input.name}"${input.description ? ` — ${input.description}` : ''}`
    case 'github_create_branch':
      return `${input.owner}/${input.repo} → ${input.branch}`
    case 'github_commit_file':
      return `${input.owner}/${input.repo}@${input.branch}: ${input.path}`
    case 'github_create_pr':
      return `${input.owner}/${input.repo}: "${input.title}" (${input.head} → ${input.base})`
    case 'vercel_get_project':
      return String(input.idOrName ?? '')
    case 'vercel_deploy':
      return `${input.projectName} (${input.target ?? 'preview'})`
    case 'netlify_get_site':
      return String(input.siteId ?? '')
    case 'netlify_create_site':
      return String(input.name ?? '')
    case 'netlify_deploy':
      return `site ${input.siteId}`
    case 'WebSearch':
      return String(input.query ?? '')
    case 'WebFetch':
      return String(input.url ?? '')
    default:
      return preview(inputRaw, 140)
  }
}
