import { randomUUID } from "node:crypto"
import type { JsonValue } from "../json"
import type { ObjectOverride } from "../materialization/model"
import { resolveEffectiveObject, storedObjectEditedAt } from "../materializer/effective/resolve"
import {
  validateEffectiveObject,
  validateObjectAuthorityProperties,
} from "../materializer/effective/validate"
import { vectorConfiguration, vectorSources } from "../objects/vectors/profile"
import { collectArtifactRefIds } from "../ontology/artifact-ref"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { type UniqueValueKind, uniquePropertiesOf, uniqueValueKey } from "../ontology/unique-values"
import type { MaterializationObjectState, StoredSourceObjectAssertion } from "../storage/ontology"
import {
  type CompiledMigrationSteps,
  compileMigrationSteps,
  type MigrationHeldUniqueProperty,
  type MigrationUniqueCollision,
  moveKeyList,
  moveKeys,
  type OntologyMigrationRunType,
  type OntologyMigrationValueStorage,
  type StagedObjectValues,
} from "../storage/ontology/migrations"
import type { Storage } from "../storage/types"
import { sameJson } from "./steps/kind"
import type { OntologyMigrationStep } from "./types"

/** Objects per `readState`, which reads at most 1,000 at once. */
const PAGE_ROWS = 1_000

/** Staged rows sent to storage at once. */
const STAGE_ROWS = 5_000

/** Failures named in the error; the rest are counted. */
const LISTED_FAILURES = 100

/** A planned type, with its steps as the code declares them: the functions of its value steps. */
export interface ValuePlanType {
  readonly type: OntologyMigrationRunType
  /** `type.steps`' definitions, in the same order. */
  readonly definitions: readonly OntologyMigrationStep[]
  /**
   * The properties the code's projections feed on the type. An object a source row stands for
   * gets no fill of one: its next run gives it the projection's value, which an edit would mask.
   */
  readonly projected: ReadonlySet<string>
}

interface Failure {
  readonly migrationId: string
  readonly line: string
  /** How many failed objects the line names: one, or each staged object of a collision. */
  readonly objects?: number
}

/** One object's stored state as the run's steps move it, before anything is written. */
interface ObjectState {
  readonly override: ObjectOverride | null
  readonly editedAt: Readonly<Record<string, string>>
  readonly source: StoredSourceObjectAssertion | null
  /** The properties a fill of this run gave a value: already in the new schema. */
  readonly filled: ReadonlySet<string>
}

/**
 * The plan of a run's value steps, before its point of no return: each type's edits are read in
 * pages, each object goes through the type's steps in order (key steps as moves, then each value
 * step's function over the object as the earlier steps leave it), and what changes is checked as a
 * commit checks it, then staged under `runId`. Unique keys the staged values would share are found
 * in storage last.
 *
 * Throws, naming every object that fails, when a function throws or returns `undefined`, a value
 * doesn't validate, or a unique key collides. The caller then discards the staging: nothing else
 * was written.
 */
export async function planValueSteps(input: {
  readonly storage: Storage
  readonly values: OntologyMigrationValueStorage
  /** Pages of 1,000 objects read side by side: the provider's lanes. */
  readonly parallelism: number
  readonly projectId: string
  readonly runId: string
  /** The run's start: a filled value's edit time. */
  readonly startedAt: string
  readonly ontology: OntologyDefinitionCatalog
  readonly types: readonly ValuePlanType[]
}): Promise<void> {
  const failures: Failure[] = []
  let failed = 0
  const fail = (failure: Failure) => {
    failed += 1
    if (failures.length < LISTED_FAILURES) failures.push(failure)
  }

  const held: MigrationHeldUniqueProperty[] = []
  for (const planned of input.types) {
    if (!planned.definitions.some(isValueStep)) continue

    const planner = typePlanner(input, planned, fail, () => failed === 0)
    await planner.run()
    held.push(...planner.held)
  }

  if (failed === 0) {
    const collisions = await input.values.findUniqueCollisions({
      projectId: input.projectId,
      runId: input.runId,
      held,
      limit: LISTED_FAILURES,
    })
    for (const collision of collisions) {
      const migrationId = valueMigrationOf(input.types, collision)
      failed += collision.primaryIds.length
      const objects = collision.primaryIds.length
      failures.push({ migrationId, line: collisionLine(collision), objects })
    }
  }

  if (failed > 0) throw planFailure(failures, failed)
}

function typePlanner(
  input: Parameters<typeof planValueSteps>[0],
  planned: ValuePlanType,
  fail: (failure: Failure) => void,
  staging: () => boolean
) {
  const { storage, values, projectId, ontology, startedAt } = input
  const { type, definitions } = planned
  const { objectTypeId } = type
  const objectType = ontology.resolveObjectType(objectTypeId)
  const primaryPropertyId = ontology.getPrimaryPropertyId(objectTypeId)
  const valueTypes = ontology.getValueTypesById()
  const compiled = compileMigrationSteps(type)

  // Each key step on its own, as it moves an object between the value steps around it.
  const moves = type.steps.map((step) =>
    step.kind === "removeProperty" || step.kind === "renameProperty"
      ? compileMigrationSteps({ ...type, steps: [step] })
      : null
  )
  const storedKey = (id: string) => compiled.renames.find((rename) => rename.to === id)?.from ?? id

  const kinds = new Map(
    uniquePropertiesOf(objectType, valueTypes).map((property) => [
      property.propertyId,
      property.kind,
    ])
  )
  const unique = new Map<string, { readonly kind: UniqueValueKind; readonly update: boolean }>()
  for (const step of type.steps) {
    if (step.kind !== "fillProperty" && step.kind !== "convertProperty") continue

    const kind = step.unique ? kinds.get(step.propertyId) : undefined
    if (kind) unique.set(step.propertyId, { kind, update: step.unique === "update" })
  }

  const profiles = Object.entries(objectType.search?.vectors ?? {}).filter(([, profile]) =>
    profile.source.some((id) => compiled.valuePropertyIds.includes(id))
  )

  const target = {
    projectId,
    objectTypeId,
    creates: definitions.some((step) => step.kind === "fillProperty"),
    holding: definitions.flatMap((step) =>
      step.kind === "convertProperty" ? [storedKey(step.propertyId)] : []
    ),
    clearing: definitions.flatMap((step) =>
      step.kind === "fillProperty" ? [storedKey(step.propertyId)] : []
    ),
    // A key whose kind changes is rebuilt after the run: every object's is staged, to check them.
    everyObject: [...unique.values()].some((property) => !property.update),
  }

  const resolve = (state: MaterializationObjectState, moved: ObjectState) =>
    resolveEffectiveObject({
      ref: state.ref,
      primaryPropertyId,
      source: moved.source,
      override: moved.override,
      editedAt: moved.editedAt,
      latestTelemetry: state.latestTelemetry,
    })?.properties

  /** One object through the type's steps: what it stages, or `null` when nothing changes. */
  function planObject(state: MaterializationObjectState): StagedObjectValues | null {
    const { primaryId } = state.ref
    let current: ObjectState = {
      override: state.override?.value ?? null,
      // As materialization reads it: a legacy edit without times holds its update's.
      editedAt: storedObjectEditedAt(state.override),
      source: state.source,
      filled: new Set(),
    }
    let keyed = current
    const edits: Record<string, JsonValue> = {}
    const editedAt: Record<string, string> = {}
    const restored: string[] = []
    let lastMigrationId = type.steps[0]!.migrationId

    for (const [index, step] of type.steps.entries()) {
      const move = moves[index]
      if (move) {
        current = moveState(current, move)
        keyed = moveState(keyed, move)
        continue
      }

      const definition = definitions[index]!
      if (!isValueStep(definition)) continue

      const given = giveValue(state, current, definition)
      if (given === null) continue
      if ("reason" in given) {
        fail({
          migrationId: step.migrationId,
          line: objectLine(objectTypeId, primaryId, given.reason),
        })
        return null
      }

      if (
        current.override?.kind === "patch" &&
        current.override.unset.includes(definition.propertyId)
      ) {
        restored.push(definition.propertyId)
      }
      current = given.state
      lastMigrationId = step.migrationId
      edits[definition.propertyId] = given.value
      if (definition.kind === "fillProperty") editedAt[definition.propertyId] = startedAt
    }

    const before = resolve(state, keyed)
    const after = resolve(state, current)
    const effective: Record<string, JsonValue> = {}
    for (const propertyId of compiled.valuePropertyIds) {
      const value = after?.[propertyId]
      if (value !== undefined && !sameJson(value, before?.[propertyId]))
        effective[propertyId] = value
    }

    const keys: Record<string, { readonly from: string | null; readonly to: string | null }> = {}
    for (const [propertyId, { kind, update }] of unique) {
      const to = uniqueValueKey(kind, after?.[propertyId])
      // The key the stored values hold: the object's row, under the id until the run.
      const from = uniqueValueKey(kind, state.effective?.properties[storedKey(propertyId)])
      if (update ? from !== to : to !== null) keys[propertyId] = { from: update ? from : null, to }
    }

    const changed = Object.keys(edits).length > 0
    if (!changed && Object.keys(keys).length === 0) return null

    // Checked as a commit checks it: an object its edits created, whole; a projected one, by the
    // edit values the steps gave it, already normalized: its source values are the projection's.
    const created = current.override?.kind === "create" && !current.source
    if (changed && created && after) {
      try {
        validateEffectiveObject(ontology, state.ref, after)
      } catch (error) {
        const line = objectLine(objectTypeId, primaryId, messageOf(error))
        fail({ migrationId: lastMigrationId, line })
        return null
      }
    }

    // A vector source that is no longer text fails the object, as it fails a commit.
    let vectors: StagedObjectValues["vectors"] = []
    try {
      if (after && Object.keys(effective).length > 0) vectors = vectorRequests(before, after)
    } catch (error) {
      const line = objectLine(objectTypeId, primaryId, messageOf(error))
      fail({ migrationId: lastMigrationId, line })
      return null
    }

    return { objectTypeId, primaryId, edits, editedAt, restored, effective, unique: keys, vectors }
  }

  /** Indexing for each profile over a value step's property whose source text changed. */
  function vectorRequests(
    before: Readonly<Record<string, JsonValue>> | undefined,
    after: Readonly<Record<string, JsonValue>>
  ): StagedObjectValues["vectors"] {
    return profiles.flatMap(([profile, definition]) => {
      const next = vectorSources(definition.source, after).sourceFingerprint
      if (before && fingerprintOf(definition.source, before) === next) return []

      const configuration = vectorConfiguration(definition)
      return [{ id: randomUUID(), profile, configuration, sourceFingerprint: next }]
    })
  }

  /**
   * What one value step gives the object: the state with its new edit value, `null` when the step
   * doesn't apply to it or leaves its value as it was, or why it fails.
   *
   * - A fill gives a value to an object its edit created and whose effective value is missing,
   *   unless a source row feeds the property: an edit there would mask the projection's value.
   * - A convert rewrites each edit value in place, a losing one included, keeping its edit time.
   *   A value a fill gave in this run is already in the new schema.
   */
  function giveValue(
    state: MaterializationObjectState,
    current: ObjectState,
    step: Extract<OntologyMigrationStep, { kind: "fillProperty" | "convertProperty" }>
  ):
    | { readonly state: ObjectState; readonly value: JsonValue }
    | { readonly reason: string }
    | null {
    const { override } = current
    const { propertyId } = step
    const { primaryId } = state.ref
    if (!override || override.kind === "delete") return null

    const values = override.kind === "create" ? override.properties : override.set
    const object = resolve(state, current) ?? { ...values, [primaryPropertyId]: primaryId }
    const call = `${step.kind}('${propertyId}')`
    let returned: unknown

    if (step.kind === "fillProperty") {
      // A `create` edit that lacks the value, or a `patch` that cleared it.
      if (object[propertyId] !== undefined) return null
      if (override.kind === "patch" && !override.unset.includes(propertyId)) return null

      const source = current.source?.assertion
      const fed =
        source !== undefined &&
        (planned.projected.has(propertyId) ||
          Object.hasOwn(source.properties, propertyId) ||
          (source.absentSourcePropertyIds ?? []).includes(propertyId))

      // Only the edit that cleared a projection's value can bring it back.
      if (fed && override.kind === "patch") {
        return {
          reason:
            `'${propertyId}' was cleared by an edit over the projection's value, and a fill ` +
            "never edits a property a projection feeds: reset that edit, or keep the property optional.",
        }
      }
      if (fed) return null

      try {
        returned = step.fill({ primaryId, object: structuredClone(object) })
      } catch (error) {
        return { reason: `${call} failed: ${messageOf(error)}` }
      }
      if (returned === undefined) {
        return { reason: `${call} returned undefined: return a value, or null for none.` }
      }
    } else {
      if (!Object.hasOwn(values, propertyId) || current.filled.has(propertyId)) return null

      try {
        const value = structuredClone(values[propertyId]!)
        returned = step.convert({ primaryId, value, object: structuredClone(object) })
      } catch (error) {
        return { reason: `${call} failed: ${messageOf(error)}` }
      }
      if (returned === undefined) {
        return { reason: `${call} returned undefined: return null to clear the value.` }
      }
    }

    let value: JsonValue
    try {
      const normalized = validateObjectAuthorityProperties(ontology, state.ref, {
        [propertyId]: returned as JsonValue,
      })
      value = normalized[propertyId]!
    } catch (error) {
      return { reason: messageOf(error) }
    }

    const property = objectType.properties.find((candidate) => candidate.id === propertyId)!
    if (collectArtifactRefIds(property.schema, value, valueTypes, new Set()).size > 0) {
      return { reason: `${call} returned a file reference: a migration can't attach files.` }
    }
    if (Object.hasOwn(values, propertyId) && sameJson(values[propertyId], value)) return null

    // A value a patch cleared is set again: the id leaves its `unset`.
    const next = { ...values, [propertyId]: value }
    const nextOverride: ObjectOverride =
      override.kind === "create"
        ? { ...override, properties: next }
        : { ...override, set: next, unset: override.unset.filter((id) => id !== propertyId) }
    if (step.kind === "convertProperty")
      return { state: { ...current, override: nextOverride }, value }

    return {
      state: {
        ...current,
        override: nextOverride,
        editedAt: { ...current.editedAt, [propertyId]: startedAt },
        filled: new Set([...current.filled, propertyId]),
      },
      value,
    }
  }

  return {
    /** The unique properties whose values outside the staging stay: collisions with them count. */
    held: [...unique]
      .filter(([, property]) => property.update)
      .map(([propertyId]) => ({
        objectTypeId,
        propertyId,
        storedPropertyId: storedKey(propertyId),
      })),

    async run(): Promise<void> {
      // A page is as many reads of `readState`'s 1,000 objects as the provider runs side by side.
      const reads = Math.max(1, input.parallelism)
      const read = async (afterPrimaryId: string | undefined) => {
        const page = await values.listValueTargets({
          ...target,
          limit: PAGE_ROWS * reads,
          ...(afterPrimaryId === undefined ? {} : { afterPrimaryId }),
        })
        if (page.primaryIds.length === 0) return null

        const chunks = []
        for (let start = 0; start < page.primaryIds.length; start += PAGE_ROWS) {
          chunks.push(page.primaryIds.slice(start, start + PAGE_ROWS))
        }
        const states = await Promise.all(
          chunks.map((primaryIds) =>
            storage.ontology.materializations.readState({
              projectId,
              objects: primaryIds.map((primaryId) => ({ objectTypeId, primaryId })),
              links: [],
              linkScopes: [],
            })
          )
        )
        return { objects: states.flatMap((state) => state.objects), next: page.nextPrimaryId }
      }

      // The next page is read while this one runs its functions, and one write of staged rows
      // stays in flight beside them.
      let pending: StagedObjectValues[] = []
      let writing: Promise<void> = Promise.resolve()
      const flush = async () => {
        await writing
        const rows = pending
        pending = []
        if (rows.length > 0 && staging()) {
          writing = values.stageValues({ projectId, runId: input.runId, rows })
          writing.catch(() => undefined)
        }
      }

      let reading = read(undefined)
      for (;;) {
        const page = await reading
        if (!page) break
        reading = page.next === undefined ? Promise.resolve(null) : read(page.next)
        reading.catch(() => undefined)

        for (const object of page.objects) {
          const row = planObject(object)
          if (row) pending.push(row)
        }
        if (pending.length >= STAGE_ROWS) await flush()
      }

      await flush()
      await writing
    },
  }
}

/** The state with a key step's keys dropped or renamed, in the edit, its times and the source row. */
function moveState(state: ObjectState, compiled: CompiledMigrationSteps): ObjectState {
  const { override, source } = state
  let moved = override

  if (override?.kind === "create") {
    moved = { ...override, properties: moveKeys(override.properties, compiled) }
  } else if (override?.kind === "patch") {
    moved = {
      ...override,
      set: moveKeys(override.set, compiled),
      unset: moveKeyList(override.unset, compiled),
    }
  }

  const assertion = source?.assertion
  const absent = assertion?.absentSourcePropertyIds
  return {
    ...state,
    override: moved,
    editedAt: moveKeys(state.editedAt, compiled),
    source:
      source && assertion
        ? {
            ...source,
            assertion: {
              ...assertion,
              properties: moveKeys(assertion.properties, compiled),
              ...(absent ? { absentSourcePropertyIds: moveKeyList(absent, compiled) } : {}),
            },
          }
        : null,
  }
}

function isValueStep(
  step: OntologyMigrationStep
): step is Extract<OntologyMigrationStep, { kind: "fillProperty" | "convertProperty" }> {
  return step.kind === "fillProperty" || step.kind === "convertProperty"
}

function propertyIdOf(step: OntologyMigrationRunType["steps"][number]): string {
  return "propertyId" in step ? step.propertyId : ""
}

/** The fingerprint the object's vector was indexed from, or `null` when its old values aren't text. */
function fingerprintOf(
  source: readonly string[],
  properties: Readonly<Record<string, JsonValue>>
): string | null {
  try {
    return vectorSources(source, properties).sourceFingerprint
  } catch {
    return null
  }
}

/** The migration whose value step gives the colliding property its values. */
function valueMigrationOf(
  types: readonly ValuePlanType[],
  collision: MigrationUniqueCollision
): string {
  const type = types.find((planned) => planned.type.objectTypeId === collision.objectTypeId)
  const step = type?.type.steps.find(
    (candidate) => propertyIdOf(candidate) === collision.propertyId
  )
  return step?.migrationId ?? type?.type.steps[0]?.migrationId ?? "unknown"
}

function collisionLine(collision: MigrationUniqueCollision): string {
  const [first, ...others] = collision.primaryIds
  const value = `'${collision.propertyId}' would take ${JSON.stringify(collision.valueKey)}`
  const reason = collision.holder
    ? `${value}, which '${collision.holder}' holds.`
    : `${value}, as would ${others.map((id) => `'${id}'`).join(", ")}.`
  return objectLine(collision.objectTypeId, first!, reason)
}

function objectLine(objectTypeId: string, primaryId: string, reason: string): string {
  return `${objectTypeId} '${primaryId}': ${reason.replace(/^\[Sixb\] /, "")}`
}

function planFailure(failures: readonly Failure[], failed: number): Error {
  const ids = [...new Set(failures.map((failure) => failure.migrationId))].sort()
  const names = ids.map((id) => `'${id}'`).join(", ")
  const objects = failed === 1 ? "1 object fails" : `${failed.toLocaleString("en-US")} objects fail`
  const named = failures.reduce((sum, failure) => sum + (failure.objects ?? 1), 0)
  const more = failed - named

  return new Error(
    [
      `[Sixb] ${ids.length === 1 ? "Migration" : "Migrations"} ${names} cannot apply: ${objects}.`,
      ...failures.map((failure) => `  ${failure.line}`),
      ...(more > 0 ? [`  … and ${more.toLocaleString("en-US")} more.`] : []),
      "Nothing was written. Fix the functions or the data, then deploy again.",
    ].join("\n")
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
