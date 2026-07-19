import { MaterializationValidationError } from "../../materialization/errors"
import type {
  EditCommitResult,
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyEditCommit,
  OntologyMaterializationOrigin,
  OntologyOperationOutcome,
} from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  objectRefKey,
  objectRefSortKey,
} from "../../materialization/refs"
import { isActionMaterializationRunStorage } from "../../storage"
import type {
  MaterializationLinkScopeState,
  MaterializationPlanWorkItem,
  MaterializationWorkRecord,
  OntologyCommitWrite,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveLink, diffEffectiveObject } from "../effective/diff"
import { validateEffectiveObject } from "../effective/validate"
import {
  attachRunReplay,
  attachRunReplayTransaction,
  replayCommit,
  requireOntologyStorage,
  withSerializationRetry,
} from "../execution/commit-lifecycle"
import { drainStagedEvents, drainStagedWork, stageWorkBounded } from "../execution/work-executor"
import {
  appendLinkEffectivePlan,
  appendLinkOverridePlan,
  appendObjectEffectivePlan,
  appendObjectOverridePlan,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import {
  createActionIdempotencyKey,
  createRuntimeIdempotencyKey,
  createTimedCommitIdentity,
} from "../shared/identity"
import { normalizeOntologyEditCommit } from "../shared/normalize"
import { applyEditOperation } from "./operations"
import {
  resolveLink,
  resolveObject,
  validateWorkingCardinality,
  type WorkingLink,
  type WorkingObject,
} from "./working-state"

export async function commitEdits(
  context: MaterializerContext,
  raw: OntologyEditCommit
): Promise<EditCommitResult> {
  const input = normalizeOntologyEditCommit(raw)
  if (input.source.kind === "action") {
    const actionRuns = context.storage.actionRuns
    if (!isActionMaterializationRunStorage(actionRuns)) {
      throw new MaterializationValidationError(
        "Storage does not provide Action run capabilities required by this commit."
      )
    }
    await actionRuns.assertMaterializationRun({
      projectId: context.projectId,
      actionId: input.source.actionId,
      runId: input.source.runId,
    })
  }
  const idempotencyKey =
    input.source.kind === "action"
      ? createActionIdempotencyKey(input.source.runId)
      : createRuntimeIdempotencyKey(input.source.requestId)
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: input,
    now: context.clock(),
  })
  const replay = await replayCommit<EditCommitResult>(context, identity)
  if (replay) {
    if (input.source.kind === "action") {
      await attachRunReplayTransaction(context, {
        kind: "action",
        actionId: input.source.actionId,
        runId: input.source.runId,
        commitId: identity.commitId,
      })
    }
    return replay
  }
  const origin: OntologyMaterializationOrigin = input.source

  return withSerializationRetry(context, async () =>
    context.storage.transaction(
      async (txBase) => {
        const tx = requireOntologyStorage(txBase)
        if (input.source.kind === "action") {
          const actionRuns = tx.actionRuns
          if (!isActionMaterializationRunStorage(actionRuns)) {
            throw new MaterializationValidationError(
              "Storage transaction does not provide Action run capabilities."
            )
          }
          await actionRuns.assertMaterializationRun({
            projectId: context.projectId,
            actionId: input.source.actionId,
            runId: input.source.runId,
          })
        }
        const replayInTransaction = await replayCommit<EditCommitResult>(context, identity, tx)
        if (replayInTransaction) {
          if (input.source.kind === "action") {
            await attachRunReplay(tx, context.projectId, {
              kind: "action",
              actionId: input.source.actionId,
              runId: input.source.runId,
              commitId: identity.commitId,
            })
          }
          return replayInTransaction
        }
        const expected =
          input.mode === "atomic"
            ? {
                objects: input.expectedObjects,
                links: input.expectedLinks,
                linkScopes: input.expectedLinkScopes,
              }
            : { objects: [], links: [], linkScopes: [] }
        const commit: OntologyCommitWrite = {
          projectId: context.projectId,
          id: identity.commitId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
          origin,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ontologyRevision: context.projectionRegistry.ontologyRevision,
          intent: { kind: "edit", mode: input.mode, operationCount: input.operations.length },
          committedAt: identity.committedAt,
        }
        const session = await tx.ontology.materializations.begin({
          commit,
          expected: {
            sources: [],
            objects: expected.objects,
            links: expected.links,
            linkScopes: expected.linkScopes,
            points: [],
          },
        })

        const objects = new Map<string, WorkingObject>()
        const links = new Map<string, WorkingLink>()
        const scopeSnapshots = new Map<string, MaterializationLinkScopeState>()
        const outcomes: OntologyOperationOutcome[] = []

        const workingState = { objects, links, scopeSnapshots }
        for (const operation of input.operations) {
          try {
            outcomes.push(
              await applyEditOperation(
                context,
                tx.ontology.materializations,
                session,
                workingState,
                operation,
                identity
              )
            )
          } catch (error) {
            if (input.mode === "atomic" || !(error instanceof MaterializationValidationError)) {
              throw error
            }
            outcomes.push({
              id: operation.id,
              ok: false,
              error: { code: "validation", message: error.message },
            })
          }
        }

        const objectChanges: EffectiveObjectChange[] = []
        const linkChanges: EffectiveLinkChange[] = []
        validateWorkingCardinality(context.ontology, objects, links, scopeSnapshots)
        for (const working of [...objects.values()].sort((a, b) => {
          const left = objectRefSortKey(a.ref)
          const right = objectRefSortKey(b.ref)
          return left < right ? -1 : left > right ? 1 : 0
        })) {
          const items: MaterializationPlanWorkItem[] = []
          appendObjectOverridePlan(items, working, identity)
          const resolved = resolveObject(context.ontology, working)
          if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
          const change = diffEffectiveObject({
            before: working.before,
            resolved,
            commitId: identity.commitId,
            committedAt: identity.committedAt,
          })
          if (change) {
            objectChanges.push(change)
            appendObjectEffectivePlan(items, change)
          }
          const sortKey = objectRefSortKey(working.ref)
          const work: MaterializationWorkRecord[] = [
            classificationWork("object", objectRefKey(working.ref), sortKey),
            ...items.map((item) => planWork(item, sortKey)),
          ]
          if (change) {
            work.push(
              eventWork(
                buildObjectMaterializationEventDraft({
                  projectId: context.projectId,
                  commitId: identity.commitId,
                  committedAt: identity.committedAt,
                  origin,
                  ...(input.actor !== undefined ? { actor: input.actor } : {}),
                  change,
                })
              )
            )
          }
          await stageWorkBounded(context, tx.ontology.materializations, session, work)
        }
        for (const working of [...links.values()].sort((a, b) => {
          const left = linkRefSortKey(a.ref)
          const right = linkRefSortKey(b.ref)
          return left < right ? -1 : left > right ? 1 : 0
        })) {
          const items: MaterializationPlanWorkItem[] = []
          appendLinkOverridePlan(items, working, identity)
          const resolved = resolveLink(context.ontology, working, objects)
          const change = diffEffectiveLink({
            before: working.before,
            resolved,
            commitId: identity.commitId,
            committedAt: identity.committedAt,
          })
          if (change) {
            linkChanges.push(change)
            appendLinkEffectivePlan(items, change)
          }
          const sortKey = linkRefSortKey(working.ref)
          const work: MaterializationWorkRecord[] = [
            classificationWork("link", linkRefKey(working.ref), sortKey),
            ...items.map((item) => planWork(item, sortKey)),
          ]
          if (change) {
            work.push(
              eventWork(
                buildLinkMaterializationEventDraft({
                  projectId: context.projectId,
                  commitId: identity.commitId,
                  committedAt: identity.committedAt,
                  origin,
                  ...(input.actor !== undefined ? { actor: input.actor } : {}),
                  change,
                })
              )
            )
          }
          await stageWorkBounded(context, tx.ontology.materializations, session, work)
        }

        await drainStagedWork(context, tx.ontology.materializations, session)
        const eventCount = await drainStagedEvents(
          context,
          tx.ontology.materializations,
          session,
          identity
        )

        const result: EditCommitResult = {
          kind: "edit",
          commitId: identity.commitId,
          created: true,
          eventCount,
          outcomes,
          changes: { objects: objectChanges, links: linkChanges },
        }
        const applied = await tx.ontology.materializations.finalize({
          session,
          finalization: {
            sourceActivations: [],
            result,
            ...(input.source.kind === "action"
              ? {
                  bookkeeping: {
                    kind: "action" as const,
                    actionId: input.source.actionId,
                    runId: input.source.runId,
                    commitId: identity.commitId,
                  },
                }
              : {}),
          },
        })
        return applied.commit.result as EditCommitResult
      },
      { isolation: "serializable" }
    )
  )
}
