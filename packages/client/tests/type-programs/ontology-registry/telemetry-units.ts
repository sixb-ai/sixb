/**
 * Units of a telemetry property whose semantic type comes from a referenced value type.
 *
 * `valueTypeRef(Temperature)` carries the value type's schema but not its semantic type, so the unit
 * is known only through the registered value type. Both telemetry surfaces — the object handle a
 * Workflow writes through and the batch history an Action reads — must require and type it.
 */
import type { ActionReadFacade, Sixb, UnitsOf } from "@sixb/core"
import { Room } from "./ontology/buildings"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

declare const sixb: Sixb
declare const read: ActionReadFacade

async function contract(): Promise<void> {
  const at = new Date("2026-01-01T00:00:00Z")
  const channel = sixb.objects(Room).byId("room-1").telemetry(Room.p.currentTemperature)

  await channel.append({ value: 293.15, at, unit: "kelvin" })
  // @ts-expect-error A referenced semantic type requires a unit.
  await channel.append({ value: 20, at })
  // @ts-expect-error A referenced temperature cannot use pressure units.
  await channel.append({ value: 20, at, unit: "millibar" })

  const points = await channel.history()
  type _historyUnit = Expect<
    Equal<(typeof points)[number]["unit"], UnitsOf<"Temperature"> | undefined>
  >

  const [series] = await read.telemetry.historyBatch({
    series: [{ objectId: "room-1", property: Room.p.currentTemperature }],
  })
  type _batchUnit = Expect<
    Equal<(typeof series.points)[number]["unit"], UnitsOf<"Temperature"> | undefined>
  >
}

void contract
