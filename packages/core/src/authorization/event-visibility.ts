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
 *
 * A type the principal views only under a condition holds no view grant, so it is hidden here
 * unless the caller names it in `conditioned`: it then passes, and the caller decides on the
 * objects the event names.
 */

import type { StoredDomainEvent } from "../events"
import { isAllowed } from "./decision"
import type { AuthorizationContext } from "./types"

const NO_CONDITIONS: ReadonlySet<string> = new Set()

export function canViewEvent(
  authorization: AuthorizationContext | null | undefined,
  event: StoredDomainEvent,
  conditioned: Pick<ReadonlySet<string>, "has"> = NO_CONDITIONS
): boolean {
  if (!authorization) {
    return true
  }

  const viewsObjects = (objectTypeId: string) =>
    conditioned.has(objectTypeId) || isAllowed(authorization, { kind: "object.view", objectTypeId })

  switch (event.topic) {
    case "objects":
    case "telemetry":
      return viewsObjects(event.payload.objectTypeId)
    case "links":
      return viewsObjects(event.payload.sourceTypeId) && viewsObjects(event.payload.targetTypeId)
    case "workflows":
      return isAllowed(authorization, {
        kind: "workflow.run",
        workflowId: event.payload.workflowId,
      })
    case "rules":
      // Rule events carry the object they fired on, so gate on viewing it —
      // otherwise they leak the existence and id of hidden-type objects.
      return viewsObjects(event.payload.subject.objectTypeId)
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
    case "users":
      // Member events carry profiles and invitee emails: the member directory's grant.
      return isAllowed(authorization, { kind: "users.view" })
    default:
      // Fail closed: an unmodeled topic may carry a subject we don't yet gate.
      return false
  }
}
