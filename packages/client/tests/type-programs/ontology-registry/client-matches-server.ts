/**
 * The browser and the server type a query identically.
 *
 * `objects(Type)` from `@sixb/client/query` and `sixb.objects(Type)` on the server build the same
 * query builder over the same generated registry, so a query — and every row it returns — has
 * one type wherever it is written. Before the registry was shared, the client resolved id-only
 * links that the server left untyped, and each client query root carried its own registry type.
 */

import { objects } from "@sixb/client/query"
import type { Sixb } from "@sixb/core"
import { Room } from "./ontology/buildings"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
// Rows, not builders, are compared: relating two builder instantiations makes TypeScript measure
// the builder's variance, which this program must not depend on.
type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

declare const sixb: Sixb

const onServer = sixb.objects(Room).query().traverse(Room.l.thermostat)
const inBrowser = objects(Room).query().traverse(Room.l.thermostat)
type _sameRow = Expect<Equal<RowOf<typeof inBrowser>, RowOf<typeof onServer>>>
type _thermostat = Expect<Equal<RowOf<typeof inBrowser>["objectTypeId"], "Thermostat">>

const expandedOnServer = sixb
  .objects(Room)
  .query()
  .expand(Room.l.thermostat)
  .expand(Room.l.adjacent)
const expandedInBrowser = objects(Room).query().expand(Room.l.thermostat).expand(Room.l.adjacent)
type _sameExpandedRow = Expect<
  Equal<RowOf<typeof expandedInBrowser>, RowOf<typeof expandedOnServer>>
>

function expandedRowAssertions(row: RowOf<typeof expandedInBrowser>): void {
  const model: string | undefined = row.links.thermostat?.properties.model
  const adjacentNames: string[] = row.links.adjacent.map((room) => room.properties.name)
  void [model, adjacentNames]
}
void expandedRowAssertions
