export function money(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

export function preview(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Same as preview(), but strips Markdown syntax first (**bold**, "- " bullets) so a
 * truncated one-line table cell doesn't show literal asterisks/dashes. */
export function markdownPreview(text: string, max = 160): string {
  const stripped = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n+/g, ' ')
  return preview(stripped, max)
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
  github_commit_files: 'Commit files',
  github_create_pr: 'Open PR',
  github_merge_pr: 'Merge PR',
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

/**
 * Short, human "type of action" label for a tool call, e.g. "Create repo".
 *
 * The fallback is deliberately generic rather than a map entry per tool: connectors are
 * declared in manifests now, so a new one must read acceptably here without a frontend
 * change. `stripe_create_payment_link` becomes "Stripe create payment link"; only tools
 * whose default reads badly earn a hand-written entry above.
 */
export function actionLabel(toolName: string): string {
  const short = shortToolName(toolName)
  const label = ACTION_LABEL[short]
  if (label) return label
  const words = short.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
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
    case 'github_commit_files': {
      const files = Array.isArray(input.files) ? (input.files as { path?: string }[]) : []
      return `${input.owner}/${input.repo}@${input.branch}: ${files.length} files (${files
        .slice(0, 3)
        .map((f) => f.path)
        .join(', ')}${files.length > 3 ? ', …' : ''})`
    }
    case 'github_merge_pr':
      return `${input.owner}/${input.repo}: PR #${input.pullNumber} (${input.mergeMethod ?? 'squash'})`
    case 'github_create_pr':
      return `${input.owner}/${input.repo}: "${input.title}" (${input.head} → ${input.base})`
    case 'vercel_get_project':
      return String(input.idOrName ?? '')
    case 'vercel_deploy': {
      // Names the source, because "deployed the repo" and "deployed 3 inline files" are
      // different enough acts that a row saying only the project name hides which happened.
      const repo = input.fromRepo as { owner?: string; repo?: string; directory?: string } | undefined
      const from = repo
        ? `from ${repo.owner}/${repo.repo}${repo.directory ? `/${repo.directory}` : ''}`
        : `${(input.files as unknown[] | undefined)?.length ?? 0} inline file(s)`
      return `${input.projectName} (${input.target ?? 'preview'}) — ${from}`
    }
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
    default: {
      // Connector tools have no hand-written case, by design. Their arguments are flat
      // scalars by construction (a manifest can't declare anything else), so listing them
      // reads far better than the raw JSON this used to fall back to.
      const scalars = Object.entries(input).filter(([, v]) => v !== null && typeof v !== 'object')
      if (scalars.length === 0) return preview(inputRaw, 140)
      return scalars
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ')
        .slice(0, 140)
    }
  }
}

/**
 * Does a row match a free-text filter, where the filter may name the row's id?
 *
 * Lessons and research notes are referred to by id everywhere the id is not actually
 * visible: `lesson_reinforce({id: 12})` in the action log, "already says this (73% similar)"
 * dedup refusals naming `#12`, an outcome citing a lesson, this project's own notes. The
 * only way to open one was to already know the `/lessons/12` deep link, because the search
 * box matched body text alone.
 *
 * `#12` is treated as an id and nothing else -- the `#` is how someone says "I mean the id",
 * and letting it also match prose would bury the one row asked for. A bare `12` matches the
 * id *or* the text, since a number in a lesson body is a legitimate thing to search for.
 */
export function matchesQuery(query: string, id: number, ...text: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (q.startsWith('#')) return String(id) === q.slice(1).trim()
  if (/^\d+$/.test(q) && String(id) === q) return true
  return text.join(' ').toLowerCase().includes(q)
}
