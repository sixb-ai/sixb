/**
 * ObjectByIdHandle binds operations to a specific object id within an ObjectSet.
 * Created via `sixb.objects(MyType).byId("id-1")`, it provides link/unlink and
 * per-property telemetry appenders with compile-time unit and value type safety.
 */
import type { ActionDefinition } from "../../actions"
import { assertAuthorized, assertPrivileged } from "../../authorization"
import type { ObjectLink, ObjectRef, ValueType } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { LinkToken, ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import { assertLinkTokenBelongsToObjectType } from "../../ontology/validation"
import type { ObjectByIdHandle, TwinObject } from "../../runtime/types"
import {
  requestActionAndWait as requestActionAndWaitLeaf,
  requestAction as requestActionLeaf,
} from "../action"
import type { ResolvedLinkContext, ResolvedObjectContext } from "../context"
import { removeLink as removeLinkLeaf, upsertLink as upsertLinkLeaf } from "../link"
import { createTelemetryAppender } from "./telemetry-appender"

type ObjectRefInput = ObjectRef
type AnyLinkToken = LinkToken<string, string, string | readonly string[], ObjectLink>

export function createObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(ctx: ResolvedObjectContext, primaryId: string): ObjectByIdHandle<TObjectType, TValueTypes> {
  const objectHandle = {
    get: async () => {
      assertAuthorized(ctx, { kind: "object.view", objectTypeId: ctx.objectType.id })
      const row = await ctx.storage.objects.getByPrimaryId({
        projectId: ctx.projectId,
        objectTypeId: ctx.objectType.id,
        primaryId,
      })
      return row ? (row as unknown as TwinObject<TObjectType, TValueTypes>) : null
    },

    listLinks: async (linkToken?: AnyLinkToken) => {
      // Link rows reveal target types; no link grant semantics exist yet.
      assertPrivileged(ctx, "listLinks")
      if (linkToken) {
        assertLinkTokenBelongsToObjectType(ctx.objectType, linkToken)
      }
      return ctx.storage.objects.listLinks({
        projectId: ctx.projectId,
        objectTypeId: ctx.objectType.id,
        objectId: primaryId,
        linkId: linkToken?.id,
      })
    },

    link: async (
      linkToken: AnyLinkToken,
      target: ObjectRefInput,
      options?: { properties?: Record<string, unknown> }
    ) => {
      assertLinkTokenBelongsToObjectType(ctx.objectType, linkToken)

      const linkCtx: ResolvedLinkContext = { ...ctx, linkDefinition: linkToken.link }
      await upsertLinkLeaf(linkCtx, {
        sourceId: primaryId,
        linkId: linkToken.id,
        targetTypeId: target.objectTypeId,
        targetId: target.primaryId,
        properties: options?.properties,
      })
    },

    unlink: async (linkToken: AnyLinkToken, target: ObjectRefInput) => {
      assertLinkTokenBelongsToObjectType(ctx.objectType, linkToken)

      const linkCtx: ResolvedLinkContext = { ...ctx, linkDefinition: linkToken.link }
      await removeLinkLeaf(linkCtx, {
        sourceId: primaryId,
        linkId: linkToken.id,
        targetTypeId: target.objectTypeId,
        targetId: target.primaryId,
      })
    },

    requestAction: async (input: {
      action?: ActionDefinition
      actionId?: string
      params?: Record<string, unknown>
      runId?: string
    }) => {
      const actionId = input.action?.id ?? input.actionId
      if (!actionId) {
        throw new OntologyValidationError(
          "[Sixb] requestAction requires either 'action' or 'actionId'"
        )
      }
      return requestActionLeaf(ctx, {
        primaryId,
        actionId,
        params: input.params,
        options: { runId: input.runId },
      })
    },

    requestActionAndWait: async (input: {
      action?: ActionDefinition
      actionId?: string
      params?: Record<string, unknown>
      timeoutMs?: number
      signal?: AbortSignal
    }) => {
      const actionId = input.action?.id ?? input.actionId
      if (!actionId) {
        throw new OntologyValidationError(
          "[Sixb] requestActionAndWait requires either 'action' or 'actionId'"
        )
      }
      return requestActionAndWaitLeaf(ctx, {
        primaryId,
        actionId,
        params: input.params,
        options: {
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        },
      })
    },

    telemetry: createTelemetryAppender<TObjectType, TValueTypes>(ctx, primaryId),
  }

  return objectHandle as unknown as ObjectByIdHandle<TObjectType, TValueTypes>
}
