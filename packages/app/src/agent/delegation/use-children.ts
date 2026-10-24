import {
  type AgentRunStreamEvent,
  isSixbApiError,
  type ListAgentThreadChildrenResponse,
} from "@sixb/client"
import {
  listAgentThreadChildrenOptions,
  listAgentThreadChildrenQueryKey,
  listAgentThreadMessagesOptions,
  listObservedAgentThreadChildrenOptions,
  listObservedAgentThreadChildrenQueryKey,
  listObservedAgentThreadMessagesOptions,
  useAgentRunStream,
} from "@sixb/client/hooks"
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { createLiveRunState, type LiveRunState, liveRunReducer } from "../live-run"
import type { AgentChild } from "./interpret"

/** How often a list is read again while one of its children waits on its turn to continue. */
const RESUME_POLL_MS = 4_000

/** While a child is at work: the reader without a stream polls, the others only to recover. */
const OBSERVED_POLL_MS = 5_000
const RECOVERY_POLL_MS = 15_000

/**
 * While a child waits on a decision or an answer: an observer hears of neither, so it reads again,
 * slowly. The others read again when the decision or the turn that answers comes.
 */
const OBSERVED_WAITING_POLL_MS = 15_000

/** While the turn streaming now spawned a child its list does not have yet. */
const SPAWN_POLL_MS = 2_000

/** A child's cost is read again at most this often while it works. */
const STEP_REFRESH_MS = 2_000

/**
 * Where a turn's children are read: its conversation's list, through the observer's routes or
 * not, and the turn that spawned them, whose readers may stop them.
 */
export interface ChildrenSource {
  readonly threadId: string | null
  /** The turn that spawned them. */
  readonly runId: string | null
  readonly observed: boolean
}

interface ThreadChildrenInput extends Pick<ChildrenSource, "threadId" | "observed"> {
  /** The children the turn's parts name, which the list should hold. */
  readonly spawnedIds: readonly string[]
  /** The turn is streaming now, so a child it named may not be listed yet. */
  readonly live: boolean
}

export interface ThreadChildren {
  /** By the id `spawn_agent` answered with. */
  readonly views: ReadonlyMap<string, AgentChild>
  /** The reader cannot read them, such as in a fork without access to the original. */
  readonly unavailable: boolean
}

/**
 * The children of a conversation, as the reader may read them, kept current while they work: one
 * list per conversation, which each turn's cards share.
 */
export function useThreadChildren(input: ThreadChildrenInput): ThreadChildren {
  const { threadId, observed, spawnedIds, live } = input
  const refetchInterval = (current: {
    readonly state: { readonly status: string; readonly data?: ListAgentThreadChildrenResponse }
  }) => {
    if (current.state.status === "error") return false

    const children = current.state.data?.children ?? []
    const listed = new Set(children.map((child) => child.id))
    if (live && spawnedIds.some((id) => !listed.has(id))) return SPAWN_POLL_MS
    if (children.some((child) => child.awaiting?.type === "resume")) return RESUME_POLL_MS
    if (children.some((child) => child.status === "queued" || child.status === "running")) {
      return observed ? OBSERVED_POLL_MS : RECOVERY_POLL_MS
    }
    if (observed && children.some((child) => child.awaiting !== undefined)) {
      return OBSERVED_WAITING_POLL_MS
    }
    return false
  }

  // An observer reads them through the observed routes, the others through the thread's.
  const path = { threadId: threadId ?? "" }
  const own = useQuery({
    ...listAgentThreadChildrenOptions({ path }),
    enabled: !observed && threadId !== null,
    retry: retryReadable,
    refetchInterval,
  })
  const observedList = useQuery({
    ...listObservedAgentThreadChildrenOptions({ path }),
    enabled: observed && threadId !== null,
    retry: retryReadable,
    refetchInterval,
  })
  const query = observed ? observedList : own

  const children = query.data?.children
  const views = useMemo(
    () => new Map((children ?? []).map((child) => [child.id, child])),
    [children]
  )
  return { views, unavailable: isUnavailable(query.error) }
}

/** What a child did: its thread's messages, read as the conversation's transcript reads its own. */
export function useChildMessages(input: {
  /** The child's thread. */
  readonly threadId: string
  readonly observed: boolean
  readonly enabled: boolean
}) {
  const { threadId, observed, enabled } = input
  const options = { path: { threadId }, query: { order: "asc" as const } }
  const own = useQuery({
    ...listAgentThreadMessagesOptions(options),
    enabled: enabled && !observed,
    retry: retryReadable,
  })
  const observedMessages = useQuery({
    ...listObservedAgentThreadMessagesOptions(options),
    enabled: enabled && observed,
    retry: retryReadable,
  })
  return observed ? observedMessages : own
}

/** The live work of each child run a turn streams, by run id. */
export type ChildLives = ReadonlyMap<string, LiveRunState>

type LivesAction = { readonly runId: string; readonly event: AgentRunStreamEvent }

function livesReducer(state: ChildLives, action: LivesAction): ChildLives {
  const current = state.get(action.runId) ?? createLiveRunState(action.runId)
  const next = liveRunReducer(current, { type: "event", event: action.event })
  if (next === current) return state

  const lives = new Map(state)
  lives.set(action.runId, next)
  return lives
}

/**
 * Follow the children of a conversation at work: a socket per run streaming, and the list read
 * again as a run goes through its steps and when one ends.
 */
export function useChildLives(source: ChildrenSource) {
  const queryClient = useQueryClient()
  const [lives, dispatch] = useReducer(livesReducer, new Map() as ChildLives)
  const lastRefresh = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { threadId } = source

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    []
  )

  // The list holds each child's cost: read it again, throttled, as steps go by.
  const refreshCost = useCallback(() => {
    if (threadId === null || pending.current) return
    const run = () => {
      lastRefresh.current = Date.now()
      pending.current = null
      void refreshChildren(queryClient, source)
    }

    const wait = STEP_REFRESH_MS - (Date.now() - lastRefresh.current)
    if (wait <= 0) run()
    else pending.current = setTimeout(run, wait)
  }, [queryClient, source, threadId])

  const onEvent = useCallback(
    (childRunId: string, event: AgentRunStreamEvent) => {
      dispatch({ runId: childRunId, event })
      if (threadId === null) return

      if (event.type === "agent.run.finished") {
        void refreshChildren(queryClient, source)
      } else if (event.type === "agent.ui.chunk" && isStepStart(event.chunk)) {
        refreshCost()
      }
    },
    [queryClient, source, threadId, refreshCost]
  )

  return { lives, onEvent }
}

/** A socket on one child run at work. Renders nothing. */
export function ChildStream({
  runId,
  onEvent,
}: {
  readonly runId: string
  readonly onEvent: (runId: string, event: AgentRunStreamEvent) => void
}) {
  useAgentRunStream({ runId, onEvent: (event) => onEvent(runId, event) })
  return null
}

/** Read a conversation's children again, through the routes the reader reads them by. */
export function refreshChildren(
  queryClient: QueryClient,
  source: Pick<ChildrenSource, "threadId" | "observed">
) {
  const { threadId, observed } = source
  if (threadId === null) return Promise.resolve()

  const queryKey = observed
    ? listObservedAgentThreadChildrenQueryKey({ path: { threadId } })
    : listAgentThreadChildrenQueryKey({ path: { threadId } })
  return queryClient.invalidateQueries({ queryKey, exact: true })
}

function isStepStart(chunk: unknown): boolean {
  return typeof chunk === "object" && chunk !== null && Reflect.get(chunk, "type") === "start-step"
}

/** A conversation the reader may not read never becomes readable by asking again. */
function retryReadable(failures: number, error: unknown): boolean {
  return !isUnavailable(error) && failures < 2
}

function isUnavailable(error: unknown): boolean {
  return isSixbApiError(error) && (error.status === 404 || error.status === 403)
}
