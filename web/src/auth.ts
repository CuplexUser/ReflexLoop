// web/src/auth.ts
//
// Holds the shared API token the backend asks for when AGENT_API_TOKEN is set.
// One secret for the whole console, kept in localStorage -- this is a gate
// against another device on the same network reaching the decision endpoint,
// not a user identity system. GET /api/status reports whether a token is
// required at all, so the UI only prompts when the backend actually wants one.

const STORAGE_KEY = 'reflexloop:api-token'

let token: string = readStoredToken()

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function getToken(): string {
  return token
}

export function setToken(next: string): void {
  token = next
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, next)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage blocked -- the token still works for this session
  }
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** The WebSocket API can't send headers, so the socket carries the same secret as a query param. */
export function withTokenParam(url: string): string {
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}token=${encodeURIComponent(token)}`
}
