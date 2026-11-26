import { stepKindOf } from "../migrations/steps"
import type { MigrationDefinition } from "../migrations/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { type TypeShape, typeShape } from "../ontology/type-shapes"
import {
  formatTypeShapeFindings,
  type ProbedChange,
} from "../storage/migrations/type-shape-messages"
import { classifyTypeChanges } from "../storage/migrations/type-shapes"
import type { SnapshotSkipKind, SnapshotTypeManifest, SnapshotTypeShape } from "./format"

/** How a type of the snapshot fits the importing runtime's definition of it. */
export type TypeFit =
  | {
      readonly fits: true
      /**
       * What production's objects fit, which the branch records before its gate runs: absent
       * from a version 2 snapshot, and for a type production never recorded. The gate then reads
       * the copy as a first deploy does.
       */
      readonly recorded?: SnapshotTypeShape
      /** Production's properties the branch neither declares nor migrates: their values are left out. */
      readonly droppedPropertyIds: readonly string[]
      /** Production's links the branch removed or changed, with no step that moves them: left out. */
      readonly droppedLinkIds: readonly string[]
      /** Links a pending step removes, with production's cardinality: they load, and it runs. */
      readonly movedLinks: ReadonlyMap<string, "one" | "many">
      /** Properties unique in production too, whose values the load claims as they are. */
      readonly uniquePropertyIds: readonly string[]
      /**
       * The removals no migration covers, whose data the copy leaves out: a deploy refuses each
       * one the data holds, counted as the copy loads; a withheld key's is only said to be held.
       */
      readonly leftOut: readonly ProbedChange[]
      /**
       * Keys production's objects hold that its code no longer declares: their values don't
       * travel (`SnapshotTypeShape.withheld`).
       */
      readonly withheld: readonly string[]
      /** Withheld keys a deploy refuses to drop with no migration, said from production's data. */
      readonly refusedWithheld: readonly ProbedChange[]
      /**
       * Changes of a withheld key the copy can't check: a pending step moves it, or a view
       * condition hides objects of the type, so it may be held only by objects the person can't see.
       */
      readonly unchecked: readonly ProbedChange[]
      /** What to do about a left-out removal: the migration lines a deploy prints. */
      remedy(change: ProbedChange): readonly string[]
      /** Whether the branch keeps a property's values: it declares it, or a pending step moves it. */
      keeps(propertyId: string): boolean
    }
  | {
      readonly fits: false
      readonly kind: Exclude<SnapshotSkipKind, "unreadable" | "unfit">
      readonly reason: string
      /** The lines a deploy prints for it, when the shapes alone decide them. */
      readonly findings: readonly string[]
    }

/**
 * What of a type the copy can load, decided from the shapes before anything is read, with the
 * gate's own classification (`classifyTypeChanges`). Only what can't be stored at all skips the
 * type here: a removed type, a changed primary property, a type production was migrating, and
 * pending steps that conflict. A removed property or link nothing migrates is left out of the
 * objects. Every other change loads, the keys and links a pending step moves included, and the
 * branch's gate decides it from the copy's data, as a deploy decides from production's.
 */
export function checkTypeFits(input: {
  readonly manifest: SnapshotTypeManifest
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  /** Whether the branch's storage applies migrations: without it, a pending one can't run. */
  readonly appliesMigrations: boolean
}): TypeFit {
  const { manifest, ontology, migrations } = input
  const objectTypeId = manifest.objectTypeId
  const objectType = ontology.getObjectTypeById(objectTypeId)
  if (!objectType) return skip("removed", "the branch no longer defines this type")

  const primaryPropertyId = ontology.getPrimaryPropertyId(objectTypeId)
  if (primaryPropertyId !== manifest.primaryPropertyId) {
    return skip(
      "primary",
      `its primary property changed from '${manifest.primaryPropertyId}' to '${primaryPropertyId}'`
    )
  }

  const shape = manifest.shape
  if (shape?.state === "migrating") {
    return skip("migrating", "production was applying a migration to it")
  }

  // A version 2 snapshot says nothing of what production's objects fit: everything loads, keys
  // its code no longer declares included, and the branch's gate reads the copy as a first
  // deploy does.
  if (!shape) {
    return {
      fits: true,
      droppedPropertyIds: [],
      droppedLinkIds: [],
      movedLinks: new Map(),
      uniquePropertyIds: [],
      leftOut: [],
      withheld: [],
      refusedWithheld: [],
      unchecked: [],
      remedy: () => [],
      keeps: () => true,
    }
  }

  const withheld = shape.withheld ?? []
  const from = withWithheldKeys(shape.fits, withheld)
  const code = typeShape(objectType, ontology)
  const classes = classifyTypeChanges({
    objectTypeId,
    from,
    code,
    ontology,
    migrations,
    settled: new Set(shape.settledMigrationIds),
    appliesMigrations: input.appliesMigrations,
  })
  if (classes.conflicts.length > 0) {
    return skip(
      "conflict",
      "two of the branch's pending migrations change the same thing",
      formatTypeShapeFindings(classes.conflicts)
    )
  }

  // The keys and links a pending step reads or moves load with their values, so the step has them.
  const subjects = classes.coverage.steps.flatMap(({ step }) => stepKindOf(step).subjects(step))
  const moved = new Set(
    subjects.flatMap((subject) => (subject.role === "link" ? [] : [subject.id]))
  )
  const movedLinks = new Map(
    subjects.flatMap((subject) => {
      const link = subject.role === "link" ? from.links[subject.id] : undefined
      return link ? [[subject.id, link.cardinality] as const] : []
    })
  )
  const keeps = (propertyId: string) =>
    code.properties[propertyId] !== undefined || moved.has(propertyId)

  const changed = [...classes.missing, ...classes.runnable, ...classes.blocked]
  const changedLinks = new Set(
    changed.flatMap((change) => ("linkId" in change ? [change.linkId] : []))
  )

  // A withheld key's removal is refused from production's data; any other change of it can't be
  // read here, nor its removal when the key may be held only by objects the person can't see.
  const leftOut = classes.missing.filter(isRemoval)
  const ofWithheld = (change: ProbedChange) =>
    "propertyId" in change &&
    (withheld.includes(change.propertyId) ||
      withheld.includes(classes.coverage.storedKey(change.propertyId)))
  const refusedWithheld = manifest.throughCondition
    ? []
    : leftOut.filter((change) => ofWithheld(change))

  return {
    fits: true,
    ...(shape.state === "current" ? { recorded: shape } : {}),
    droppedPropertyIds: Object.keys(shape.fits.properties).filter((id) => !keeps(id)),
    droppedLinkIds: Object.keys(shape.fits.links).filter(
      (linkId) =>
        !movedLinks.has(linkId) && (code.links[linkId] === undefined || changedLinks.has(linkId))
    ),
    movedLinks,
    uniquePropertyIds: Object.keys(shape.fits.properties).filter(
      (propertyId) => shape.fits.properties[propertyId]!.unique
    ),
    leftOut,
    withheld,
    refusedWithheld,
    unchecked: changed.filter((change) => ofWithheld(change) && !refusedWithheld.includes(change)),
    remedy: (change) => classes.coverage.remedy(change),
    keeps,
  }
}

/** Production's shape, with the keys its objects hold that it no longer declares. */
function withWithheldKeys(shape: TypeShape, withheld: readonly string[]): TypeShape {
  const missing = withheld.filter((propertyId) => !(propertyId in shape.properties))
  if (missing.length === 0) return shape

  const unknown = { schema: "unknown", unknown: true } as const
  return {
    ...shape,
    properties: {
      ...shape.properties,
      ...Object.fromEntries(missing.map((propertyId) => [propertyId, unknown])),
    },
  }
}

/** A removal whose data the copy leaves out: the branch no longer has anything to hold it. */
function isRemoval(change: ProbedChange): boolean {
  switch (change.kind) {
    case "property-removed":
    case "link-removed":
    case "link-targets":
    case "link-cardinality":
    case "link-added":
      return true
    default:
      return false
  }
}

function skip(
  kind: Extract<TypeFit, { fits: false }>["kind"],
  reason: string,
  findings: readonly string[] = []
): TypeFit {
  return { fits: false, kind, reason, findings }
}
