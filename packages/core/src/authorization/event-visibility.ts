/**
 * Event visibility derived from grants.
 *
 * There is no standalone "view events" capability: a principal sees a domain
 * event only when it can view/apply/run the event's subject. A privileged
 * caller (no authorization context) sees everything.
 *
 * The topic switch is fail-closed: an unrecognized topic is hidden, because a
 * topic we don't yet model may carry a subject the principal is not allowed to
 * see. Adding an event topic therefore requires an explicit visibility decision
 * here, never a silent default.
 */

import type { StoredDomainEvent } from "../events"
import { isAllowed } from "./decision"
import type { AuthorizationContext } from "./types"

export function canViewEvent(
  authorization: AuthorizationContext | null | undefined,
  event: StoredDomainEvent
): boolean {
  if (!authorization) {
    return true
  }

  switch (event.topic) {
    case "objects":
    case "telemetry":
      return isAllowed(authorization, {
        kind: "object.view",
        objectTypeId: event.payload.objectTypeId,
      })
    case "links":
      return (
        isAllowed(authorization, {
          kind: "object.view",
          objectTypeId: event.payload.sourceTypeId,
        }) &&
        isAllowed(authorization, { kind: "object.view", objectTypeId: event.payload.targetTypeId })
      )
    case "actions": {
      // Apply is necessary; for object-bound actions the principal must also be
      // able to view the subject type, or the event would leak a hidden
      // object's id/type — mirroring the rule in `canListAction`.
      if (!isAllowed(authorization, { kind: "action.apply", actionId: event.payload.actionId })) {
        return false
      }
      const subject = event.payload.subject
      return subject.kind === "object"
        ? isAllowed(authorization, { kind: "object.view", objectTypeId: subject.objectTypeId })
        : true
    }
    case "workflows":
      return isAllowed(authorization, {
        kind: "workflow.run",
        workflowId: event.payload.workflowId,
      })
    case "rules":
      // Rule events carry the object they fired on, so gate on viewing it —
      // otherwise they leak the existence and id of hidden-type objects.
      return isAllowed(authorization, {
        kind: "object.view",
        objectTypeId: event.payload.subject.objectTypeId,
      })
    // Run grant gates the operational stream. These payloads may also carry the
    // produced datasetId/versionId; that target is already visible to a runner
    // through the sync/pipeline catalog (`sync.target.dataset`), so surfacing it
    // here discloses nothing new.
    case "syncs":
      return isAllowed(authorization, {
        kind: "sync.run",
        syncId: event.payload.syncId,
      })
    case "pipelines":
      return isAllowed(authorization, {
        kind: "pipeline.run",
        pipelineId: event.payload.pipelineId,
      })
    case "schedules":
      // Infra topics with no object/action/workflow/dataset subject: no grant
      // governs them yet, so they stay visible to any authorized reader. When
      // they gain their own grants, add the checks here.
      return true
    case "datasets":
      // dataset.view alone. The payload's `producer` (the sync/pipeline that
      // produced the version, plus its runId) is intentionally visible to any
      // dataset viewer as provenance — the same identity the versions API
      // already serializes for that principal. This is distinct from the
      // operational `references` in the dataset catalog (which syncs/pipelines
      // are wired to a dataset), which stays gated on the run grants.
      return isAllowed(authorization, {
        kind: "dataset.view",
        datasetId: event.payload.datasetId,
      })
    default:
      // Fail closed: an unmodeled topic may carry a subject we don't yet gate.
      return false
  }
}
