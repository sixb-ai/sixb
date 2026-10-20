/**
 * Unique values while an edit commit applies its operations.
 *
 * Storage refuses a duplicate when the commit applies, which fails the whole commit: exactly what
 * an atomic commit needs, so only continue mode checks earlier, for a batch to fail only the item
 * that collides:
 *
 * - before the operations run, one state read loads the holders of every value they could claim;
 * - each object transition then moves its own values in a working index, O(changed values);
 * - `assertDistinct` checks the values claimed since its last call, after each item or group.
 *
 * Storage stays the final guard: a value claimed by a commit that lands after this read is still
 * refused when this commit applies.
 */
import type { JsonValue } from "../../json"
import { UniqueValueViolationError } from "../../materialization/errors"
import type { OntologyEditOperation, OntologyObjectRef } from "../../materialization/model"
import { objectRefKey } from "../../materialization/refs"
import type { OntologyRegistry } from "../../ontology"
import { uniqueValueKey } from "../../ontology/unique-values"
import { normalizeSchemaValue } from "../../ontology/validation"
import type {
  ExactUniqueValueWrite,
  MaterializationSession,
  OntologyMaterializationStorage,
  UniqueValueRef,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { oneStateRequest } from "../effective/load-state"
import type { WorkingObject } from "./working-state"

type Properties = Readonly<Record<string, JsonValue>> | undefined

export class WorkingUniqueValues {
  /** Values claimed since the last check, by `uniqueKey`. */
  private readonly claims = new Map<string, ExactUniqueValueWrite>()

  private constructor(
    private readonly ontology: OntologyRegistry,
    /** Holder primary ids by `uniqueKey`: more than one only between two checks. */
    private readonly holders: Map<string, Set<string>>,
    private readonly tracked: boolean
  ) {}

  /** For an atomic commit, which storage checks as a whole: transitions track nothing. */
  static untracked(ontology: OntologyRegistry): WorkingUniqueValues {
    return new WorkingUniqueValues(ontology, new Map(), false)
  }

  /** Reads the holders of every unique value the operations could give to their objects. */
  static async load(
    context: Pick<MaterializerContext, "ontology" | "batching">,
    storage: OntologyMaterializationStorage,
    session: MaterializationSession,
    operations: readonly OntologyEditOperation[],
    objects: ReadonlyMap<string, WorkingObject>
  ): Promise<WorkingUniqueValues> {
    const holders = new Map<string, Set<string>>()
    const requested = candidateValues(context.ontology, operations, objects)
    if (requested.length === 0) return new WorkingUniqueValues(context.ontology, holders, true)

    const request = {
      objects: [],
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: [],
      uniqueValues: requested,
    }
    for await (const page of storage.streamState({
      session,
      requests: oneStateRequest(request),
      pageRows: context.batching.statePageRows,
    })) {
      for (const holder of page.uniqueHolders ?? []) {
        holders.set(uniqueKey(holder), new Set([holder.primaryId]))
      }
    }

    return new WorkingUniqueValues(context.ontology, holders, true)
  }

  /** Moves the unique values of `ref` from `before` to `after`, and returns how to undo it. */
  transition(ref: OntologyObjectRef, before: Properties, after: Properties): () => void {
    if (!this.tracked) return () => undefined
    const moves: { readonly released: string | null; readonly claimed: string | null }[] = []

    for (const { propertyId, kind } of this.ontology.listUniqueProperties(ref.objectTypeId)) {
      const released = uniqueValueKey(kind, before?.[propertyId])
      const claimed = uniqueValueKey(kind, after?.[propertyId])
      if (released === claimed) continue

      const value = { objectTypeId: ref.objectTypeId, propertyId }
      const releasedKey = released === null ? null : uniqueKey({ ...value, valueKey: released })
      if (releasedKey !== null) this.holders.get(releasedKey)?.delete(ref.primaryId)

      let claimedKey: string | null = null
      if (claimed !== null) {
        const claim = { ...value, valueKey: claimed, primaryId: ref.primaryId }
        claimedKey = uniqueKey(claim)
        this.holdersOf(claimedKey).add(ref.primaryId)
        this.claims.set(claimedKey, claim)
      }

      moves.push({ released: releasedKey, claimed: claimedKey })
    }

    return () => {
      for (const { released, claimed } of moves) {
        if (claimed !== null) this.holders.get(claimed)?.delete(ref.primaryId)
        if (released !== null) this.holdersOf(released).add(ref.primaryId)
      }
    }
  }

  /** Throws `UniqueValueViolationError` when a value claimed since the last check has two holders. */
  assertDistinct(): void {
    const claims = [...this.claims.entries()]
    this.claims.clear()

    for (const [key, claim] of claims) {
      const holders = this.holders.get(key)
      if (!holders || holders.size <= 1) continue
      const holder = [...holders].find((primaryId) => primaryId !== claim.primaryId)
      if (holder === undefined) continue
      throw new UniqueValueViolationError(
        claim.objectTypeId,
        claim.propertyId,
        holder,
        claim.primaryId
      )
    }
  }

  private holdersOf(key: string): Set<string> {
    let holders = this.holders.get(key)
    if (!holders) {
      holders = new Set()
      this.holders.set(key, holders)
    }
    return holders
  }
}

/**
 * Every unique value an operated object could hold after the commit: those its operation writes,
 * and those its source and its edit already assert, which a reset or a restore can bring back.
 */
function candidateValues(
  ontology: OntologyRegistry,
  operations: readonly OntologyEditOperation[],
  objects: ReadonlyMap<string, WorkingObject>
): UniqueValueRef[] {
  const values = new Map<string, UniqueValueRef>()
  const add = (ref: OntologyObjectRef, properties: Properties) => {
    for (const value of uniqueValuesOf(ontology, ref, properties)) {
      values.set(uniqueKey(value), value)
    }
  }

  for (const operation of operations) {
    if (!("objectTypeId" in operation.ref)) continue
    if (ontology.listUniqueProperties(operation.ref.objectTypeId).length === 0) continue

    if (operation.kind === "object.create" || operation.kind === "object.upsert") {
      add(operation.ref, operation.properties)
    }
    if (operation.kind === "object.patch") add(operation.ref, operation.set)

    const working = objects.get(objectRefKey(operation.ref))
    add(operation.ref, working?.source?.assertion.properties)
    const override = working?.override
    if (override?.kind === "create") add(operation.ref, override.properties)
    if (override?.kind === "patch") add(operation.ref, override.set)
  }

  return [...values.values()]
}

/** The keys of `properties`' unique values, normalized as the write will store them. */
function uniqueValuesOf(
  ontology: OntologyRegistry,
  ref: OntologyObjectRef,
  properties: Properties
): UniqueValueRef[] {
  if (!properties) return []
  const objectType = ontology.getObjectTypeById(ref.objectTypeId)
  if (!objectType) return []

  const values: UniqueValueRef[] = []
  for (const { propertyId, kind } of ontology.listUniqueProperties(ref.objectTypeId)) {
    const raw = properties[propertyId]
    const property = objectType.properties.find((candidate) => candidate.id === propertyId)
    if (raw === undefined || raw === null || !property) continue

    const valueKey = uniqueValueKey(kind, normalized(ontology, property.schema, raw))
    if (valueKey !== null) values.push({ objectTypeId: ref.objectTypeId, propertyId, valueKey })
  }
  return values
}

/** An invalid value claims nothing: the operation that writes it is refused anyway. */
function normalized(
  ontology: OntologyRegistry,
  schema: Parameters<typeof normalizeSchemaValue>[0],
  value: JsonValue
): JsonValue | undefined {
  try {
    return normalizeSchemaValue(schema, value, "", ontology.getValueTypesById())
  } catch {
    return undefined
  }
}

function uniqueKey(value: UniqueValueRef): string {
  return JSON.stringify([value.objectTypeId, value.propertyId, value.valueKey])
}
