export type AgentSurfaceMode = "collapsed" | "dock"

export const DEFAULT_AGENT_SURFACE_WIDTH = 384
export const MIN_AGENT_SURFACE_WIDTH = 320
export const MAX_AGENT_SURFACE_WIDTH = 720
export const AGENT_SURFACE_STATE_EVENT = "sixb:agent-surface-state"

export interface AgentSurfaceSessionState {
  readonly mode: AgentSurfaceMode
  readonly dockWidth: number
  readonly threadId: string | null
}

export interface AgentSurfaceStateDetail {
  readonly storageKey: string
  readonly state: AgentSurfaceSessionState
}

export function agentSurfaceSessionStorageKey(override?: string | false) {
  if (override === false) return null
  return override ?? "sixb.agent-ui.surface.v1:agents"
}

export function parseAgentSurfaceSessionState(
  raw: string | null,
  defaults: AgentSurfaceSessionState,
  minimumWidth = MIN_AGENT_SURFACE_WIDTH,
  maximumWidth = MAX_AGENT_SURFACE_WIDTH
): AgentSurfaceSessionState {
  if (!raw) return defaults

  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) return defaults
    return {
      mode: value.mode === "collapsed" || value.mode === "dock" ? value.mode : defaults.mode,
      dockWidth:
        typeof value.dockWidth === "number" && Number.isFinite(value.dockWidth)
          ? clampAgentSurfaceWidth(value.dockWidth, minimumWidth, maximumWidth)
          : defaults.dockWidth,
      threadId:
        value.threadId === null || (typeof value.threadId === "string" && value.threadId.length > 0)
          ? value.threadId
          : defaults.threadId,
    }
  } catch {
    return defaults
  }
}

export function clampAgentSurfaceWidth(width: number, minimumWidth: number, maximumWidth: number) {
  return Math.min(Math.max(Math.round(width), minimumWidth), maximumWidth)
}

/** Hand a thread created elsewhere in the app to this tab's persistent assistant surface. */
export function handoffAgentSurfaceThread(
  threadId: string | null,
  override?: string | false
): void {
  const storageKey = agentSurfaceSessionStorageKey(override)
  if (!storageKey || typeof window === "undefined") return

  const defaults: AgentSurfaceSessionState = {
    mode: "dock",
    dockWidth: DEFAULT_AGENT_SURFACE_WIDTH,
    threadId,
  }
  updateAgentSurfaceState(storageKey, defaults, (current) => ({
    ...current,
    mode: "dock",
    threadId,
  }))
}

/** Change this tab's assistant presentation without discarding its selected thread or width. */
export function setAgentSurfaceMode(mode: AgentSurfaceMode, override?: string | false): void {
  const storageKey = agentSurfaceSessionStorageKey(override)
  if (!storageKey || typeof window === "undefined") return

  const defaults: AgentSurfaceSessionState = {
    mode,
    dockWidth: DEFAULT_AGENT_SURFACE_WIDTH,
    threadId: null,
  }
  updateAgentSurfaceState(storageKey, defaults, (current) => ({ ...current, mode }))
}

function updateAgentSurfaceState(
  storageKey: string,
  defaults: AgentSurfaceSessionState,
  update: (current: AgentSurfaceSessionState) => AgentSurfaceSessionState
) {
  const current = readAgentSurfaceState(storageKey, defaults)
  const state = update(current)
  writeAgentSurfaceState(storageKey, state)
  window.dispatchEvent(
    new CustomEvent<AgentSurfaceStateDetail>(AGENT_SURFACE_STATE_EVENT, {
      detail: { storageKey, state },
    })
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readAgentSurfaceState(
  storageKey: string | null,
  defaults: AgentSurfaceSessionState,
  minimumWidth = MIN_AGENT_SURFACE_WIDTH,
  maximumWidth = MAX_AGENT_SURFACE_WIDTH
): AgentSurfaceSessionState {
  if (!storageKey || typeof window === "undefined") return defaults
  try {
    return parseAgentSurfaceSessionState(
      window.sessionStorage.getItem(storageKey),
      defaults,
      minimumWidth,
      maximumWidth
    )
  } catch {
    return defaults
  }
}

export function writeAgentSurfaceState(storageKey: string | null, state: AgentSurfaceSessionState) {
  if (!storageKey || typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // Storage may be unavailable in restricted browser contexts; in-memory state still works.
  }
}
