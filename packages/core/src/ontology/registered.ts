import type { ObjectTypeWithPropertyTokens } from "./tokens"
import type { SixbObjectTypeMap, SixbValueTypeMap, ValueType } from "./types"

/**
 * Every object type the generated ontology manifest registers.
 *
 * It is the one registry every typed surface resolves string link targets against, so the same
 * query is typed the same way in an Action, a Workflow and the browser. Without a manifest it is the
 * loose base type: id-only link targets then degrade gracefully instead of failing.
 *
 * Deliberately not generic. A registry parameterized per call site gives each site its own type
 * identity, and TypeScript then has to compare otherwise identical SDK types structurally.
 */
export type RegisteredObjectType = [keyof SixbObjectTypeMap] extends [never]
  ? ObjectTypeWithPropertyTokens
  : Extract<SixbObjectTypeMap[keyof SixbObjectTypeMap], ObjectTypeWithPropertyTokens>

/** Every value type the generated ontology manifest registers, for string-only `valueTypeRef`s. */
export type RegisteredValueTypes = readonly Extract<
  SixbValueTypeMap[keyof SixbValueTypeMap],
  ValueType
>[]
