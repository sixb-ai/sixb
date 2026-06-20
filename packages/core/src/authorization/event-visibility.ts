/**
 * Event visibility derived from grants.
 *
 * There is no standalone "view events" capability: a principal sees a domain
 * event when it can view/apply/start the event's subject. A privileged caller
 * (no authorization context) sees everything.
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
    case "actions":
      return isAllowed(authorization, { kind: "action.apply", actionId: event.payload.actionId })
    case "workflows":
      return isAllowed(authorization, {
        kind: "workflow.start",
        workflowId: event.payload.workflowId,
      })
    default:
      // Infra topics (schedules, rules, syncs, pipelines, datasets) carry no
      // object/action/workflow subject, so no grant governs them yet and they
      // stay visible to any authorized reader. When those subjects gain their
      // own grants, add their checks here so event visibility tracks them.
      return true
  }
}
