/**
 * The authorization rule for writing a link, in one place because all three link leaves need it.
 */
import { type AuthorizationContext, assertAuthorized, assertCanEdit } from "../../authorization"
import type { RuntimeAuthorization } from "../../execution"

/**
 * Assert a principal may create or remove a link.
 *
 * `edit` on the **source** type, `view` on the **target**: a link is declared on the source type
 * (`objectType.links`), and writing one changes the source's edges, not the target's properties.
 * Requiring `edit` on the target too would mean a clerk needs write access to every customer before
 * attaching an invoice to one.
 *
 * `view` on the target is still required, and for two reasons: it matches how links are *read* —
 * `canViewLink` already demands `view` on both endpoints — and without it the endpoint-existence
 * check that follows would answer whether a target the principal cannot see exists.
 *
 * Call this *before* any endpoint lookup, for that second reason.
 */
export function assertCanWriteLink(
  ctx: {
    readonly projectId: string
    readonly runtimeAuthorization?: RuntimeAuthorization
    readonly authorization?: AuthorizationContext
  },
  endpoints: { readonly sourceTypeId: string; readonly targetTypeId: string }
): void {
  assertCanEdit(ctx, endpoints.sourceTypeId)
  assertAuthorized(ctx, { kind: "object.view", objectTypeId: endpoints.targetTypeId })
}
