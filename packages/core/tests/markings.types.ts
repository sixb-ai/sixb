import {
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  prop,
  type TwinObject,
} from "../src"
import type { ObjectTypeProperties, ObjectTypeReadProperties } from "../src/ontology/tokens"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const financial = defineMarking("financial", { label: "Financial" })
type _markingId = Expect<Equal<typeof financial.id, "financial">>

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("amount", "double", { required: true, markings: [financial] }),
    prop("notes", "string", { markings: [financial] }),
  ],
})

// A reader without clearance receives a marked property redacted, so reads type it as optional.
type _read = Expect<
  Equal<
    ObjectTypeReadProperties<typeof Invoice>,
    { id: string; title: string; amount?: number; notes?: string }
  >
>
type _row = Expect<
  Equal<TwinObject<typeof Invoice>["properties"], ObjectTypeReadProperties<typeof Invoice>>
>
// Writes are unchanged: a required marked property is still required.
type _write = Expect<
  Equal<
    ObjectTypeProperties<typeof Invoice>,
    { id: string; title: string; amount: number; notes?: string }
  >
>

// @ts-expect-error markings are marking definitions, not ids
prop("amount", "double", { markings: ["financial"] })

const finance = defineGroup("finance")
defineRole("finance-clearance", { grantedTo: [finance], clearances: [financial] })
// @ts-expect-error clearances are marking definitions, not groups
defineRole("bad-clearance", { grantedTo: [finance], clearances: [finance] })
