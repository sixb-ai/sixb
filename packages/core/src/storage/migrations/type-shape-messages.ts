import type { SchemaShape, TypeShapeChange } from "../../ontology/type-shapes"

/** A change that isn't compatible: it pauses writes, and a role refuses it. */
export type NarrowedChange = Exclude<
  TypeShapeChange,
  { readonly kind: "property-optional" | "property-nullable" }
>

/**
 * A change that may leave stored data out, so a deploy reads the data before recording it. A
 * property made unique is read by unique preparation's dry run instead, which names two objects
 * that share a value before anything is written.
 */
export type ProbedChange = Exclude<NarrowedChange, { readonly kind: "property-unique" }>

export function narrows(change: TypeShapeChange): change is NarrowedChange {
  return change.effect !== "compatible"
}

export function needsData(change: TypeShapeChange): change is ProbedChange {
  return narrows(change) && change.kind !== "property-unique"
}

/** A change the stored data doesn't fit, or that a role can't decide without reading it. */
export interface TypeShapeFinding {
  readonly objectTypeId: string
  readonly change: NarrowedChange
  /** Objects that don't fit; `null` when nothing was read, as for a role. */
  readonly count: number | null
  /** One line: the type, what changed, and how many objects that leaves out. */
  readonly message: string
  /** What to do about it, one line each. */
  readonly remedy: readonly string[]
}

export function finding(
  objectTypeId: string,
  change: ProbedChange,
  count: number
): TypeShapeFinding {
  const objects = count === 1 ? "1 object" : `${count.toLocaleString("en-US")} objects`
  const described = describe(objectTypeId, change)

  return {
    objectTypeId,
    change,
    count,
    message: `${described.what}, and ${described.data(objects, count === 1)}.`,
    remedy: described.remedy,
  }
}

/** A role reads no data: it says what changed, and leaves the data to `sixb db migrate`. */
export function unprobedFinding(objectTypeId: string, change: NarrowedChange): TypeShapeFinding {
  return {
    objectTypeId,
    change,
    count: null,
    message: `${describe(objectTypeId, change).what} since its shape was recorded.`,
    remedy: [],
  }
}

/**
 * Two objects sharing a value of a property the code makes unique, as the unique dry run found
 * them, with what the deploy says to do.
 */
export function duplicateFinding(
  objectTypeId: string,
  propertyId: string,
  objects: { readonly holderPrimaryId: string; readonly claimantPrimaryId: string }
): TypeShapeFinding {
  return {
    objectTypeId,
    change: { kind: "property-unique", propertyId, unique: true, effect: "narrowing" },
    count: 2,
    message:
      `${objectTypeId}: '${propertyId}' is now unique, and objects ` +
      `'${objects.holderPrimaryId}' and '${objects.claimantPrimaryId}' share a value.`,
    remedy: ["Fix the data, then start again."],
  }
}

/** The lines `sixb check`, a deploy and the agent print for findings: one `✗` per change. */
export function formatTypeShapeFindings(findings: readonly TypeShapeFinding[]): string[] {
  return findings.flatMap((item) => [
    `✗ ${item.message}`,
    ...item.remedy.map((line) => `  ${line}`),
  ])
}

export function mismatchMessage(role: boolean, findings: readonly TypeShapeFinding[]): string {
  const lines = formatTypeShapeFindings(findings).map((line) => `  ${line}`)

  if (role) {
    return [
      "[Sixb] The code changed object types since their shape was recorded, and the stored objects may not fit:",
      ...lines,
      "Run `sixb db migrate` first: it checks the stored objects and records the new shapes.",
    ].join("\n")
  }

  return ["[Sixb] The stored objects don't fit this code:", ...lines].join("\n")
}

interface DescribedChange {
  /** The type and what changed, as the start of a sentence. */
  readonly what: string
  /** What the objects found do, given their count: "2,140 objects hold it". */
  readonly data: (objects: string, one: boolean) => string
  readonly remedy: readonly string[]
}

/**
 * Worded for whoever reads the deploy log, the agent included. The migration steps that resolve a
 * change add their own `defineMigration(...)` lines to `remedy`.
 */
function describe(type: string, change: NarrowedChange): DescribedChange {
  const hold = (objects: string, one: boolean) => `${objects} ${one ? "holds" : "hold"} it`
  const lack = (objects: string, one: boolean) =>
    `${objects} ${one ? "lacks" : "lack"} it: created without it or cleared by an edit`
  const unfit = (objects: string, one: boolean) =>
    `${objects} ${one ? "holds" : "hold"} edits it no longer accepts`

  switch (change.kind) {
    case "type-removed":
      return {
        what: `${type} was removed`,
        data: hold,
        remedy: ["Removing a type that holds objects isn't supported yet: declare it again."],
      }
    case "primary":
      return {
        what: `${type}: its primary property changed from '${change.from}' to '${change.to}'`,
        data: hold,
        remedy: [`Changing a primary property isn't supported yet: keep '${change.from}'.`],
      }
    case "property-added":
      return {
        what: `${type}: '${change.propertyId}' was added as required`,
        data: lack,
        remedy: ["Add it as optional until a migration fills it."],
      }
    case "property-required":
      return {
        what: `${type}: '${change.propertyId}' is now required`,
        data: lack,
        remedy: ["Keep it optional until a migration fills it."],
      }
    case "property-removed":
      return change.effect === "refused"
        ? {
            what: `${type}: telemetry '${change.propertyId}' was removed`,
            data: hold,
            remedy: ["Removing a telemetry property isn't supported yet: declare it again."],
          }
        : {
            what: `${type}: '${change.propertyId}' was removed`,
            data: hold,
            remedy: ["Declare it again until a migration removes it."],
          }
    case "property-mode":
      return {
        what: `${type}: '${change.propertyId}' became ${change.to}`,
        data: hold,
        remedy: ["Changing a property's mode isn't supported yet: add a new property instead."],
      }
    case "property-retyped":
    case "property-not-nullable": {
      const changed =
        change.kind === "property-retyped"
          ? `changed from ${describeSchema(change.from)} to ${describeSchema(change.to)}`
          : "no longer accepts null"
      return change.effect === "refused"
        ? {
            what: `${type}: telemetry '${change.propertyId}' ${changed}`,
            data: hold,
            remedy: [
              "Narrowing a telemetry property isn't supported yet: add a new property instead.",
            ],
          }
        : {
            what: `${type}: '${change.propertyId}' ${changed}`,
            data: unfit,
            remedy: ["Keep its old schema until a migration converts them."],
          }
    }
    case "property-unique":
      // Only a role words it: a deploy's dry run names the objects that share a value.
      return {
        what: `${type}: '${change.propertyId}' is now unique`,
        data: (objects, one) => `${objects} ${one ? "shares" : "share"} a value`,
        remedy: [],
      }
    case "link-added":
      // Only a link an earlier definition left links behind for needs data to decide.
      return {
        what: `${type}: link '${change.linkId}' was declared again`,
        data: (objects, one) =>
          `${objects} still ${one ? "holds" : "hold"} links of an earlier one`,
        remedy: ["Declaring a link again over its old links isn't supported yet: use a new id."],
      }
    case "link-removed":
      return {
        what: `${type}: link '${change.linkId}' was removed`,
        data: hold,
        remedy: ["Declare it again until a migration removes it."],
      }
    case "link-targets": {
      const dropped = change.from.filter((target) => !change.to.includes(target))
      return {
        what: `${type}: link '${change.linkId}' no longer targets ${dropped.join(", ")}`,
        data: hold,
        remedy: ["Retargeting a link isn't supported yet: add a new link instead."],
      }
    }
    case "link-cardinality":
      return {
        what: `${type}: link '${change.linkId}' became cardinality ${change.to}`,
        data: hold,
        remedy: ["Changing a link's cardinality isn't supported yet: add a new link instead."],
      }
  }
}

function describeSchema(schema: SchemaShape): string {
  if (typeof schema === "string") return schema
  if (!("type" in schema)) return `value type '${schema.valueType}'`
  if (schema.type === "enum") return `enum (${schema.values.join(", ")})`
  return schema.type
}
