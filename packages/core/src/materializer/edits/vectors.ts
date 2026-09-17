import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { OntologyEditCommit } from "../../materialization/model"
import { objectRefKey } from "../../materialization/refs"
import { normalizeVector, vectorConfiguration, vectorSources } from "../../objects/vectors/profile"
import type { Storage } from "../../storage"
import type { MaterializationSession } from "../../storage/ontology"
import type { MaterializerContext } from "../context"

export async function commitVectorWrites(
  context: MaterializerContext,
  storage: Storage,
  input: OntologyEditCommit,
  commitId: string,
  session: MaterializationSession
): Promise<void> {
  if (input.mode !== "atomic" || !input.vectorWrites?.length) return
  const vectors = storage.ontology.vectors
  if (!vectors)
    throw new MaterializationValidationError("Storage does not support vector profiles.")
  const seen = new Set<string>()
  for (const write of input.vectorWrites) {
    const prepared = write.input
    const key = JSON.stringify([objectRefKey(prepared.ref), prepared.profile])
    if (seen.has(key)) throw new MaterializationValidationError(`Duplicate vector write: ${key}`)
    seen.add(key)
    const profileDefinition = context.ontology.resolveObjectType(prepared.ref.objectTypeId).search
      ?.vectors?.[prepared.profile]
    if (
      prepared.projectId !== context.projectId ||
      !profileDefinition ||
      vectorConfiguration(profileDefinition) !== prepared.configuration
    ) {
      throw new MaterializationConflictError(
        "effective-state",
        "Vector profile configuration changed; index it again."
      )
    }
    const expected = input.expectedObjects.find(
      (entry) => objectRefKey(entry.ref) === objectRefKey(prepared.ref)
    )
    if (
      !expected?.exists ||
      !prepared.expectedObject?.exists ||
      objectRefKey(prepared.expectedObject.ref) !== objectRefKey(prepared.ref) ||
      expected.version !== prepared.expectedObject.version ||
      expected.lastCommitId !== prepared.expectedObject.lastCommitId
    ) {
      throw new MaterializationValidationError(
        "Vector writes must fence their prepared object revision."
      )
    }
    const row = await storage.objects.getByPrimaryId({
      projectId: context.projectId,
      objectTypeId: prepared.ref.objectTypeId,
      primaryId: prepared.ref.primaryId,
    })
    if (
      !row ||
      row.version !== expected.version ||
      row.lastCommitId !== expected.lastCommitId ||
      vectorSources(profileDefinition.source, row.properties).sourceFingerprint !==
        prepared.sourceFingerprint
    ) {
      throw new MaterializationConflictError(
        "effective-state",
        "Vector sources changed; index the profile again."
      )
    }
    await vectors.write({
      session,
      projectId: context.projectId,
      expectedCommitId: prepared.expectedVectorCommitId,
      value: {
        ref: prepared.ref,
        profile: prepared.profile,
        configuration: prepared.configuration,
        source: profileDefinition.source,
        sourceFingerprint: prepared.sourceFingerprint,
        values: normalizeVector(write.values, profileDefinition.model.definition.dimensions),
        lastCommitId: commitId,
      },
    })
  }
}
