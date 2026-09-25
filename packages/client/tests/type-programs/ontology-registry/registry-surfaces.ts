/**
 * One registry, one type per query.
 *
 * `sixb.objects(...)` in a Workflow or an Agent tool, `read.objects(...)` in an Action and the
 * generated manifest must agree: the same query has the same type on every surface, and every
 * surface resolves id-only link targets and string value-type references through the registry
 * `sixb typegen` generates. A surface that parameterized its own registry would type the same
 * query differently — and force TypeScript to compare otherwise identical SDK types structurally.
 */
import type {
  ActionEditsContext,
  ActionReadFacade,
  ObjectQueryBuilder,
  Sixb,
  WorkflowRuntimeFacade,
} from "@sixb/core"
import { Room, Thermostat } from "./ontology/buildings"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type RowOf<TBuilt> = TBuilt extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

declare const sixb: Sixb
declare const workflow: WorkflowRuntimeFacade
declare const read: ActionReadFacade

// ── The same query is the same type everywhere ─────────────────────────────

const fromSixb = sixb.objects(Room).query().traverse(Room.l.thermostat)
const fromWorkflow = workflow.objects(Room).query().traverse(Room.l.thermostat)
const fromAction = read.objects(Room).query().traverse(Room.l.thermostat)

type _workflowMatchesSixb = Expect<Equal<typeof fromWorkflow, typeof fromSixb>>
type _actionMatchesSixb = Expect<Equal<typeof fromAction, typeof fromSixb>>
// The id-only target resolves to the registered object type, not the loose base.
type _thermostat = Expect<Equal<typeof fromSixb, ObjectQueryBuilder<typeof Thermostat>>>

// Traversing an id-only link backwards resolves its source through the registry too.
const backToRooms = read
  .objects(Thermostat)
  .query()
  .traverse(Room.l.thermostat, { direction: "incoming" })
type _incoming = Expect<Equal<typeof backToRooms, ObjectQueryBuilder<typeof Room>>>

// ── Expanded rows ──────────────────────────────────────────────────────────

const expanded = read
  .objects(Room)
  .query()
  .expand(Room.l.thermostat)
  .expand(Room.l.adjacent)
  .expand(Room.l.ghost)

function expandedRowAssertions(row: RowOf<typeof expanded>): void {
  const model: string | undefined = row.links.thermostat?.properties.model
  // A self-link resolves to the source type.
  const adjacentNames: string[] = row.links.adjacent.map((room) => room.properties.name)
  // A target the manifest does not register is loud: the row carries the fix, not the data.
  const guidance: string | undefined = row.links.ghost?.properties.sixb_unresolvedExpansionTarget
  // @ts-expect-error — reading a real property of an unregistered target is a compile error.
  void row.links.ghost?.properties.name
  void [model, adjacentNames, guidance]
}
void expandedRowAssertions

// ── String value-type references ──────────────────────────────────────────

async function valueTypeAssertions(): Promise<void> {
  const room = await sixb.objects(Room).get("room-1")
  // `valueTypeRef("Azimuth")` carries no schema; the registered value type supplies it.
  type _azimuth = Expect<
    Equal<NonNullable<typeof room>["properties"]["azimuth"], number | undefined>
  >
  void room
}
void valueTypeAssertions

function editAssertions(ctx: ActionEditsContext<typeof Room, Record<string, never>, void>): void {
  ctx.objects(Room).create({ id: "room-1", name: "North", azimuth: 12 })
  // @ts-expect-error — the registered value type is a double.
  ctx.objects(Room).create({ id: "room-2", name: "South", azimuth: "12" })
}
void editAssertions
