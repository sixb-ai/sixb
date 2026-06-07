/**
 * Builder helpers for ontology modeling.
 *
 * These functions provide shorthand for constructing `ObjectType`, `ValueType`,
 * `Interface`, `Property`, `ObjectLink`, and `EnumSchema` values with sensible
 * defaults so you can focus on the semantics rather than boilerplate.
 *
 * ```ts
 * import { defineObjectType, prop, link, stringEnum } from "@sixb/core"
 *
 * const thermostat = defineObjectType({
 *   id: "thermostat",
 *   name: "Thermostat",
 *   properties: [
 *     prop("currentTemperature", "double", {
 *       name: "Current Temperature",
 *       semanticType: "Temperature",
 *       required: true,
 *     }),
 *     prop("mode", stringEnum(["off", "heat", "cool", "auto"])),
 *   ],
 *   links: [
 *     link("controls", "hvacZone", { cardinality: "one" }),
 *   ],
 * })
 * ```
 */

import type { ObjectTypeWithTokens } from "./tokens"
import { createLinkTokenMap, createPropertyTokenMap } from "./tokens"
import type {
  EnumSchema,
  Interface,
  LinkCardinality,
  ObjectLink,
  ObjectType,
  Ontology,
  Property,
  PropertyMode,
  PropertyQueryMetadata,
  Schema,
  ValueType,
  ValueTypeRefSchema,
} from "./types"
import type { QuantitativeTypeId } from "./units"

type NameFromOptions<TId extends string, TOptions> = TOptions extends {
  name: infer TName extends string
}
  ? TName
  : TId

/**
 * Preserve literal option values when an option key is provided.
 *
 * Why this exists:
 * - `prop("x", "string", { required: true })` should keep `required` as literal `true`
 *   (not widen to `boolean`) so downstream inference can treat the field as required.
 */
type FieldFromOptions<TOptions, TKey extends string, TFallback> =
  TOptions extends Record<TKey, infer TValue>
    ? { [K in TKey]: TValue }
    : { [K in TKey]?: TFallback }

// ── Extends type utilities ───────────────────────────────────

/**
 * Merge parent + child collections by id. Uses built-in `Exclude` on
 * the element union — no recursion, no "excessively deep" errors.
 */
type MergedCollection<
  TParent extends readonly { id: string }[],
  TChild extends readonly { id: string }[],
> = Array<Exclude<TParent[number], { id: TChild[number]["id"] }> | TChild[number]>

/**
 * Extract child's own collection, normalized as a mutable tuple. Falls back to [].
 */
type OwnCollection<TInput, TKey extends string, TItem> =
  TInput extends Record<TKey, infer T extends readonly TItem[]> ? [...T] : []

/**
 * Merge two arrays by id: parent items first, child items override by id.
 */
function mergeById<T extends { id: string }>(parent: readonly T[], child: readonly T[]): T[] {
  const childIds = new Set(child.map((item) => item.id))
  const fromParent = parent.filter((item) => !childIds.has(item.id))
  return [...fromParent, ...child]
}

// ── Object Type ─────────────────────────────────────────────

type DefineObjectTypeBase = Omit<ObjectType, "properties" | "links" | "extends" | "parents">

/**
 * Structural constraint for the `extends` field.
 *
 * We require only the data needed for merge (id + collections), not the
 * full `ObjectTypeWithTokens<ObjectType>`. The latter requires
 * `LinkTokenMap<ObjectType>` with a `{ [id: string]: LinkToken }` index
 * signature, which is incompatible with the literal-keyed maps produced by
 * concrete `defineObjectType()` calls.
 */
type DefineObjectTypeInput = DefineObjectTypeBase & {
  extends?:
    | string
    | {
        readonly id: string
        readonly properties: readonly Property[]
        readonly links: readonly ObjectLink[]
      }
  parents?: readonly string[]
  properties?: readonly Property[]
  links?: readonly ObjectLink[]
}

/**
 * Normalize `parents` from readonly tuple to mutable `string[] | undefined`.
 */
type NormalizeParents<TInput> = TInput extends { parents: infer P extends readonly string[] }
  ? { parents: [...P] }
  : { parents?: undefined }

type DefineObjectTypeResult<TInput extends DefineObjectTypeInput> = Omit<
  TInput,
  "properties" | "links" | "extends" | "parents"
> &
  (TInput extends {
    extends: infer TParent extends {
      id: string
      properties: readonly Property[]
      links: readonly ObjectLink[]
    }
  }
    ? NormalizeParents<TInput> & {
        extends: TParent["id"]
        properties: MergedCollection<
          TParent["properties"],
          OwnCollection<TInput, "properties", Property>
        >
        links: MergedCollection<TParent["links"], OwnCollection<TInput, "links", ObjectLink>>
      }
    : TInput extends { extends: infer TParentId extends string }
      ? {
          extends: TParentId
          parents: string[]
          properties: OwnCollection<TInput, "properties", Property>
          links: OwnCollection<TInput, "links", ObjectLink>
        }
      : NormalizeParents<TInput> & {
          extends: undefined
          properties: OwnCollection<TInput, "properties", Property>
          links: OwnCollection<TInput, "links", ObjectLink>
        })

type DefineObjectTypeWithTokensResult<TInput extends DefineObjectTypeInput> = ObjectTypeWithTokens<
  DefineObjectTypeResult<TInput>
>

/**
 * Define an object type with sensible defaults.
 *
 * `properties` and `links` default to `[]` so you can define
 * a bare object type with just `id` and `name`.
 */
export function defineObjectType<const TInput extends DefineObjectTypeInput>(
  input: TInput
): DefineObjectTypeWithTokensResult<TInput>
export function defineObjectType(input: DefineObjectTypeInput): ObjectTypeWithTokens<ObjectType> {
  const ext = input.extends

  const ownProperties = input.properties ? [...input.properties] : []
  const ownLinks = input.links ? [...input.links] : []

  let extendsId: string | undefined
  let parentIds: string[] | undefined
  let properties: Property[]
  let links: ObjectLink[]

  if (typeof ext === "string") {
    // Pre-flattened: string extends — no merge, properties/links taken as-is
    extendsId = ext
    parentIds = [ext, ...(input.parents ?? []).filter((id) => id !== ext)]
    properties = ownProperties
    links = ownLinks
  } else if (ext != null) {
    // Object extends — merge parent collections
    extendsId = ext.id
    parentIds = [ext.id, ...(input.parents ?? []).filter((id) => id !== ext.id)]
    properties = mergeById(ext.properties, ownProperties)
    links = mergeById([...ext.links], ownLinks)
  } else {
    // No extends
    extendsId = undefined
    parentIds = input.parents ? [...input.parents] : undefined
    properties = ownProperties
    links = ownLinks
  }

  const objectType: ObjectType = {
    id: input.id,
    name: input.name,
    description: input.description,
    quantityKind: input.quantityKind,
    seeAlso: input.seeAlso,
    extends: extendsId,
    parents: parentIds,
    implements: input.implements,
    properties,
    links,
    search: input.search,
  }

  return {
    ...objectType,
    l: createLinkTokenMap(objectType),
    p: createPropertyTokenMap(objectType),
  }
}

// ── Ontology ────────────────────────────────────────────────

type DefineOntologyBase = Omit<Ontology, "objectTypes" | "valueTypes" | "interfaces">

type DefineOntologyInput = DefineOntologyBase & {
  objectTypes?: readonly ObjectType[]
  valueTypes?: readonly ValueType[]
  interfaces?: readonly Interface[]
}

type DefineOntologyResult<TInput extends DefineOntologyInput> = Omit<
  TInput,
  "objectTypes" | "valueTypes" | "interfaces"
> & {
  objectTypes: TInput extends { objectTypes: infer TObjectTypes extends readonly ObjectType[] }
    ? [...TObjectTypes]
    : []
  valueTypes: TInput extends { valueTypes: infer TValueTypes extends readonly ValueType[] }
    ? [...TValueTypes]
    : []
  interfaces: TInput extends { interfaces: infer TInterfaces extends readonly Interface[] }
    ? [...TInterfaces]
    : []
}

/**
 * Define a complete ontology document.
 *
 * `objectTypes`, `valueTypes`, and `interfaces` default to `[]`.
 */
export function defineOntology<const TInput extends DefineOntologyInput>(
  input: TInput
): DefineOntologyResult<TInput>
export function defineOntology(input: DefineOntologyInput): Ontology {
  return {
    ...input,
    objectTypes: input.objectTypes ? [...input.objectTypes] : [],
    valueTypes: input.valueTypes ? [...input.valueTypes] : [],
    interfaces: input.interfaces ? [...input.interfaces] : [],
  }
}

// ── Value Type ──────────────────────────────────────────────

/**
 * Define a reusable value type.
 *
 * Identity function for type inference and discoverability — the `define*`
 * prefix makes it easy to find all ontology builders.
 */
export function defineValueType<const TValueType extends ValueType>(input: TValueType): TValueType {
  return input
}

// ── Interface ───────────────────────────────────────────────

type DefineInterfaceBase = Omit<Interface, "properties" | "links">

type DefineInterfaceInput = DefineInterfaceBase & {
  properties?: readonly Property[]
  links?: readonly ObjectLink[]
}

type DefineInterfaceResult<TInput extends DefineInterfaceInput> = Omit<
  TInput,
  "properties" | "links"
> & {
  properties: TInput extends { properties: infer TProperties extends readonly Property[] }
    ? [...TProperties]
    : []
  links: TInput extends { links: infer TLinks extends readonly ObjectLink[] } ? [...TLinks] : []
}

/**
 * Define a reusable interface contract.
 *
 * `properties` and `links` default to `[]`.
 */
export function defineInterface<const TInput extends DefineInterfaceInput>(
  input: TInput
): DefineInterfaceResult<TInput>
export function defineInterface(input: DefineInterfaceInput): Interface {
  return {
    ...input,
    properties: input.properties ? [...input.properties] : [],
    links: input.links ? [...input.links] : [],
  }
}

// ── Property shorthand ──────────────────────────────────────

type PropertyOptions = {
  name?: string
  description?: string
  required?: boolean
  nullable?: boolean
  primary?: true
  mode?: PropertyMode
  semanticType?: QuantitativeTypeId
  query?: PropertyQueryMetadata
}

type PropertyResult<
  TId extends string,
  TSchema extends Schema,
  TOptions extends PropertyOptions | undefined,
> = {
  id: TId
  name: NameFromOptions<TId, TOptions>
  schema: TSchema
} & FieldFromOptions<TOptions, "description", string> &
  FieldFromOptions<TOptions, "required", boolean> &
  FieldFromOptions<TOptions, "nullable", boolean> &
  FieldFromOptions<TOptions, "primary", true> &
  FieldFromOptions<TOptions, "mode", PropertyMode> &
  FieldFromOptions<TOptions, "semanticType", QuantitativeTypeId> &
  FieldFromOptions<TOptions, "query", PropertyQueryMetadata>

/**
 * Shorthand for creating a {@link Property}.
 *
 * `name` defaults to `id` — override via `options.name` when you need
 * a separate display name.
 *
 * ```ts
 * prop("currentTemperature", "double", {
 *   name: "Current Temperature",
 *   semanticType: "Temperature",
 *   required: true,
 * })
 * ```
 */
// Overloads keep option literals (e.g. `required: true`, `mode: "telemetry"`) intact.
export function prop<const TId extends string, const TSchema extends Schema>(
  id: TId,
  schema: TSchema
): PropertyResult<TId, TSchema, undefined>
export function prop<
  const TId extends string,
  const TSchema extends Schema,
  const TOptions extends PropertyOptions,
>(id: TId, schema: TSchema, options: TOptions): PropertyResult<TId, TSchema, TOptions>
export function prop(id: string, schema: Schema, options?: PropertyOptions): Property {
  return {
    id,
    name: options?.name ?? id,
    schema,
    ...options,
  }
}

// ── Link shorthand ──────────────────────────────────────────

/**
 * Runtime check: does a value look like an ObjectType?
 *
 * Discriminates ObjectType from LinkOptions by checking for `properties` and `links`
 * arrays — ObjectType always has them, LinkOptions never does.
 */
function isObjectTypeLike(value: unknown): value is ObjectType {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).properties) &&
    Array.isArray((value as Record<string, unknown>).links)
  )
}

type LinkOptions = {
  name?: string
  description?: string
  cardinality?: LinkCardinality
  properties?: Property[]
}

type LinkResult<
  TId extends string,
  TTargetObjectTypeId,
  TOptions extends LinkOptions | undefined,
> = {
  id: TId
  name: NameFromOptions<TId, TOptions>
  targetObjectTypeId: TTargetObjectTypeId
} & FieldFromOptions<TOptions, "description", string> &
  FieldFromOptions<TOptions, "cardinality", LinkCardinality> &
  FieldFromOptions<TOptions, "properties", Property[]>

/**
 * Shorthand for creating an {@link ObjectLink}.
 *
 * `name` defaults to `id`. `targetObjectTypeId` defaults to `"*"` when omitted.
 *
 * ```ts
 * // String target
 * link("controls", "hvacZone", { cardinality: "one" })
 *
 * // ObjectType target — extracts .id at build time
 * link("controls", HVACZone, { cardinality: "one" })
 *
 * // Multiple targets
 * link("rel", [TypeA, TypeB])
 *
 * // Wildcard — accepts any target type
 * link("anything")
 * link("anything", { cardinality: "many" })
 * ```
 */

// 1. Wildcard: no target → "*"
export function link<const TId extends string>(id: TId): LinkResult<TId, "*", undefined>

// 2. Single ObjectType target
export function link<const TId extends string, const TTarget extends ObjectType>(
  id: TId,
  target: TTarget
): LinkResult<TId, TTarget["id"], undefined>

// 3. Single ObjectType target + options
export function link<
  const TId extends string,
  const TTarget extends ObjectType,
  const TOptions extends LinkOptions,
>(id: TId, target: TTarget, options: TOptions): LinkResult<TId, TTarget["id"], TOptions>

// 4. ObjectType array target
export function link<const TId extends string, const TTargetId extends string>(
  id: TId,
  targets: readonly (ObjectType & { id: TTargetId })[]
): LinkResult<TId, TTargetId[], undefined>

// 5. ObjectType array target + options
export function link<
  const TId extends string,
  const TTargetId extends string,
  const TOptions extends LinkOptions,
>(
  id: TId,
  targets: readonly (ObjectType & { id: TTargetId })[],
  options: TOptions
): { id: TId; name: NameFromOptions<TId, TOptions>; targetObjectTypeId: TTargetId[] } & TOptions

// 6. String or string-array target (existing)
export function link<
  const TId extends string,
  const TTargetObjectTypeId extends string | readonly string[],
>(id: TId, targetObjectTypeId: TTargetObjectTypeId): LinkResult<TId, TTargetObjectTypeId, undefined>

// 7. String or string-array target + options (existing)
export function link<
  const TId extends string,
  const TTargetObjectTypeId extends string | readonly string[],
  const TOptions extends LinkOptions,
>(
  id: TId,
  targetObjectTypeId: TTargetObjectTypeId,
  options: TOptions
): LinkResult<TId, TTargetObjectTypeId, TOptions>

// 8. Wildcard with options — MUST be LAST (ObjectType satisfies LinkOptions structurally)
export function link<const TId extends string, const TOptions extends LinkOptions>(
  id: TId,
  options: TOptions
): { id: TId; name: NameFromOptions<TId, TOptions>; targetObjectTypeId: "*" } & TOptions

// Implementation
export function link(
  id: string,
  targetOrOptions?: string | readonly string[] | ObjectType | readonly ObjectType[] | LinkOptions,
  options?: LinkOptions
): ObjectLink {
  // No second argument → wildcard
  if (targetOrOptions === undefined) {
    return { id, name: id, targetObjectTypeId: "*" }
  }

  // String → string target
  if (typeof targetOrOptions === "string") {
    return {
      id,
      name: options?.name ?? id,
      targetObjectTypeId: targetOrOptions,
      ...options,
    }
  }

  // Array → determine element type
  if (Array.isArray(targetOrOptions)) {
    const first = targetOrOptions[0]
    const ids =
      first !== undefined && isObjectTypeLike(first)
        ? (targetOrOptions as readonly ObjectType[]).map((ot) => ot.id)
        : (targetOrOptions as string[])
    return {
      id,
      name: options?.name ?? id,
      targetObjectTypeId: ids,
      ...options,
    }
  }

  // Object with properties + links → ObjectType
  if (isObjectTypeLike(targetOrOptions)) {
    return {
      id,
      name: options?.name ?? id,
      targetObjectTypeId: (targetOrOptions as ObjectType).id,
      ...options,
    }
  }

  // Otherwise → LinkOptions (wildcard with options)
  const linkOptions = targetOrOptions as LinkOptions
  return {
    id,
    name: linkOptions.name ?? id,
    targetObjectTypeId: "*",
    ...linkOptions,
  }
}

// ── ValueType ref shorthand ─────────────────────────────────

/**
 * Create a value-type reference schema.
 *
 * ```ts
 * prop("azimuth", valueTypeRef("bsh:AzimuthShape"))
 * prop("area", valueTypeRef(AreaShape))  // self-contained, no tuple needed
 * ```
 */
// 1. String id only (existing behavior, no resolution)
export function valueTypeRef<const TId extends string>(
  valueTypeId: TId
): ValueTypeRefSchema & { valueTypeId: TId }
// 2. ValueType object (concise, self-contained)
export function valueTypeRef<const TVT extends ValueType>(
  valueType: TVT
): { type: "valueTypeRef"; valueTypeId: TVT["id"]; _resolved: TVT["schema"] }
// 3. String id + explicit schema (escape hatch)
export function valueTypeRef<const TId extends string, const TResolved extends Schema>(
  valueTypeId: TId,
  resolved: TResolved
): { type: "valueTypeRef"; valueTypeId: TId; _resolved: TResolved }
// Implementation
export function valueTypeRef(
  idOrValueType: string | ValueType,
  resolved?: Schema
): ValueTypeRefSchema {
  if (typeof idOrValueType === "string") {
    if (resolved !== undefined) {
      return { type: "valueTypeRef", valueTypeId: idOrValueType, _resolved: resolved }
    }
    return { type: "valueTypeRef", valueTypeId: idOrValueType }
  }
  return {
    type: "valueTypeRef",
    valueTypeId: idOrValueType.id,
    _resolved: idOrValueType.schema,
  }
}

// ── Enum helpers ────────────────────────────────────────────

/**
 * Create a string enum schema.
 *
 * ```ts
 * prop("mode", stringEnum(["off", "heat", "cool", "auto"]))
 * ```
 */
export function stringEnum<const V extends readonly string[]>(
  values: V
): EnumSchema & {
  values: [...V]
} {
  return { type: "enum", valueType: "string", values: [...values] }
}

/**
 * Create an integer enum schema.
 *
 * ```ts
 * prop("fanSpeed", integerEnum([1, 2, 3]))
 * ```
 */
export function integerEnum<const V extends readonly number[]>(
  values: V
): EnumSchema & {
  values: [...V]
} {
  return { type: "enum", valueType: "integer", values: [...values] }
}
