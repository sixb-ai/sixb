/**
 * What a query builder and a row accept.
 *
 * A builder is invariant in its object type — it both takes and hands out predicates and tokens of
 * that type — and covariant in its row: an expanded query still passes where the plain query is
 * expected, never the reverse. A row of an object type is a row of the loose base type.
 *
 * Builders used to carry their expansions as an accumulator: relating `plain` overflowed (TS2589)
 * and TypeScript cached a variance under which `notExpanded` passed. Guard: make `TwinObject`
 * (runtime/types.ts) read `InferObjectProperties` instead of `ObjectTypeProperties`, and this file
 * alone fails with TS2589 (TypeScript 5.9.3).
 */
import {
  defineObjectType,
  link,
  type ObjectQueryBuilder,
  type ObjectTypeWithPropertyTokens,
  prop,
  type TwinObject,
} from "../src"

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("model", "string", { required: true }),
  ],
})

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("thermostat", Thermostat, { cardinality: "one" })],
})

declare const rooms: ObjectQueryBuilder<typeof Room>
const expanded = rooms.expand(Room.l.thermostat)

export const plain: ObjectQueryBuilder<typeof Room> = expanded
// @ts-expect-error — a plain query does not return rows carrying `.links`.
export const notExpanded: typeof expanded = rooms
// @ts-expect-error — a builder over the loose base would accept predicates Room does not have.
export const loose: ObjectQueryBuilder<ObjectTypeWithPropertyTokens> = rooms

declare const room: TwinObject<typeof Room>
export const looseRoom: TwinObject<ObjectTypeWithPropertyTokens> = room
// @ts-expect-error — a row of the loose base type is not a Room row.
export const notRoom: TwinObject<typeof Room> = looseRoom
