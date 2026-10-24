import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef } from "react"
import { type TranscriptApprovals, useApprovalCards } from "../approvals"
import type { LiveRunState } from "../live-run"
import { useObservedThread } from "../observed-thread"
import { ChildCard } from "./child-card"
import { ChildGroup } from "./child-group"
import { useDelegationCards } from "./context"
import { type AgentChild, activeRun, type SpawnedChild, type ThreadDelegation } from "./interpret"
import { type ChildModel, childModel } from "./model"
import {
  type ChildrenSource,
  ChildStream,
  refreshChildren,
  useChildLives,
  useThreadChildren,
} from "./use-children"

/**
 * The sub-agents a run of the Agent's work spawned, under that work: one card each, or, for
 * several, one group that says how they stand. Each child at work streams to its card.
 */
export function ChildCards({ spawned }: { readonly spawned: readonly SpawnedChild[] }) {
  const cards = useDelegationCards()
  const observed = useObservedThread()
  const { approvals } = useApprovalCards()
  const queryClient = useQueryClient()

  const known = spawned.find((child) => !child.pending)
  const runId =
    (known ? cards?.delegation.spawnedBy.get(known.id) : undefined) ?? cards?.liveRunId ?? null
  const turnLive = runId !== null && runId === cards?.liveRunId
  const threadId = cards?.threadId ?? null
  const source = useMemo(
    (): ChildrenSource => ({ threadId, runId, observed }),
    [threadId, runId, observed]
  )

  const spawnedIds = useMemo(
    () => spawned.flatMap((child) => (child.pending ? [] : [child.id])),
    [spawned]
  )
  // One list for the conversation: each child is there by the id spawn_agent answered with.
  const { views, unavailable } = useThreadChildren({ ...source, spawnedIds, live: turnLive })
  const { lives, onEvent } = useChildLives(source)

  // A child paused on its decisions or its question continues under a later turn: read the list
  // again when a turn starts or ends.
  const liveRunId = cards?.liveRunId ?? null
  const paused = [...views.values()].some((view) => view.awaiting !== undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new turn is the trigger
  useEffect(() => {
    if (paused) void refreshChildren(queryClient, source)
  }, [liveRunId])

  const models = useChildModels(
    spawned.map((child) => {
      const view = views.get(child.id)
      const run = activeRun(view)
      return {
        child,
        view,
        live: run ? lives.get(run.id) : undefined,
        runId,
        turnLive,
        observed,
        delegation: cards?.delegation,
        approvals,
      }
    })
  )

  if (!cards) return null

  // A run at work streams to whoever reads the turn; an observer polls.
  const streaming = observed
    ? []
    : spawned.flatMap((child) => {
        const view = views.get(child.id)
        if (view) return view.activeRunId === null ? [] : [view.activeRunId]
        return turnLive && !child.pending ? [child.id] : []
      })

  return (
    <>
      {streaming.map((id) => (
        <ChildStream key={id} runId={id} onEvent={onEvent} />
      ))}
      {models.length === 1 && models[0] ? (
        <ChildCard model={models[0]} source={source} unavailable={unavailable} />
      ) : (
        <ChildGroup models={models} source={source} unavailable={unavailable} />
      )}
    </>
  )
}

interface ModelInput {
  readonly child: SpawnedChild
  readonly view?: AgentChild
  readonly live?: LiveRunState
  readonly runId: string | null
  readonly turnLive: boolean
  readonly observed: boolean
  readonly delegation?: ThreadDelegation
  readonly approvals: TranscriptApprovals | null
}

/**
 * Each child's model, the same object while nothing it is made of changed: a chunk of one child's
 * stream redraws that child's card, not its siblings'.
 */
function useChildModels(inputs: readonly ModelInput[]): readonly ChildModel[] {
  const cache = useRef(new Map<string, { readonly deps: readonly unknown[]; model: ChildModel }>())

  const models = inputs.flatMap((input) => {
    const { child, delegation } = input
    if (!delegation) return []

    const deps = [
      child.id,
      child.task,
      child.pending,
      child.model?.modelId,
      input.view,
      input.live,
      input.runId,
      input.turnLive,
      input.observed,
      delegation,
      input.approvals,
    ]
    const known = cache.current.get(child.id)
    if (known?.deps.every((dep, index) => Object.is(dep, deps[index]))) return [known.model]

    const model = childModel({ ...input, delegation })
    cache.current.set(child.id, { deps, model })
    return [model]
  })

  const ids = new Set(inputs.map((input) => input.child.id))
  for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id)
  return models
}
