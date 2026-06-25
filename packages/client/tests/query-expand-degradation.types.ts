// Typecheck-only proof that expansion-target degradation is LOUD, not silent,
// when a manifest IS present but a link's target type is missing from it (a stale
// manifest, or a wrong target id). Reading a real property of such a target must
// be a COMPILE ERROR — the old behavior degraded it silently to
// `Record<string, unknown>`. The no-manifest loose default stays graceful and is
// covered elsewhere (query-expand-manifest.types.ts / query-expand-hook.types.ts).
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { objects } from "../src/query"

// `ghost` points at "DegradeGhost", deliberately absent from the manifest below —
// while the manifest IS concrete (this file augments DegradeOrder; sibling test
// files augment more). That is exactly the "precision expected but lost" case.
const Order = defineObjectType({
  id: "DegradeOrder",
  name: "Order",
  properties: [prop("ref", "string", { required: true })],
  links: [link("ghost", "DegradeGhost", { cardinality: "one" })],
})

declare module "@sixb/core/ontology" {
  interface SixbObjectTypeMap {
    DegradeOrder: typeof Order
    // DegradeGhost intentionally NOT registered → expanding `ghost` must go loud.
  }
}

type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

const built = objects(Order).query().expand(Order.l.ghost)
type Row = RowOf<typeof built>

function unresolvedExpansionIsLoud(row: Row): void {
  // The start type resolves precisely (only the unresolved target degrades).
  const orderTypeId: "DegradeOrder" = row.objectTypeId
  const orderRef: string = row.properties.ref

  const ghost = row.links.ghost
  // The sentinel key is readable and carries the fix instructions.
  const guidance: string | undefined = ghost?.properties.sixb_unresolvedExpansionTarget
  // @ts-expect-error — unresolved expansion target: reading a real property is now
  // a compile error instead of a silent `unknown`. This is the whole point.
  void ghost?.properties.ref

  void [orderTypeId, orderRef, guidance]
}
void unresolvedExpansionIsLoud
