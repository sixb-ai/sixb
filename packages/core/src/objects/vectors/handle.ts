import { randomUUID } from "node:crypto"
import { assertCanEdit } from "../../authorization"
import { AuthorizationError } from "../../authorization/errors"
import { MaterializationValidationError } from "../../materialization/errors"
import type { PreparedObjectVector } from "../../materialization/vectors"
import { getOntologyMutationRuntime } from "../../runtime/ontology-mutations"
import type { ExecutionObjectContext } from "../context"
import { normalizeVector, vectorConfiguration, vectorSources } from "./profile"
import type { ObjectVectorHandle } from "./types"

export function createObjectVectorHandle(
  ctx: ExecutionObjectContext,
  primaryId: string,
  profileName: string
): ObjectVectorHandle {
  const ref = Object.freeze({ objectTypeId: ctx.objectType.id, primaryId })
  const profileDefinition = ctx.ontology.resolveObjectType(ref.objectTypeId).search?.vectors?.[
    profileName
  ]
  if (!profileDefinition)
    throw new MaterializationValidationError(`Unknown vector profile: ${profileName}`)
  const vectors = ctx.storage.ontology.vectors
  if (!vectors)
    throw new MaterializationValidationError("Storage does not support vector profiles.")

  const assertReadable = async () => {
    const allowed = await ctx.objectReader.canReadObjectPropertiesBatch({
      items: profileDefinition.source.map((propertyId) => ({ ...ref, propertyId })),
    })
    if (allowed.some((value) => !value))
      throw new AuthorizationError(
        `view:object:${ref.objectTypeId}`,
        "[Sixb] Vector profile requires access to all its source properties."
      )
  }

  return Object.freeze({
    async index(): Promise<void> {
      assertCanEdit(ctx, ref.objectTypeId)
      await assertReadable()
      const mutations = getOntologyMutationRuntime(ctx)
      const model = ctx.embeddingModels?.getByRef({
        provider: profileDefinition.model.providerId,
        modelId: profileDefinition.model.modelId,
      })?.model
      if (!model || model.definition.dimensions !== profileDefinition.model.definition.dimensions) {
        throw new MaterializationValidationError(
          `Vector profile '${profileName}' requires its configured embedding model.`
        )
      }
      const row = await ctx.objectReader.getByPrimaryId(ref)
      if (!row) throw new MaterializationValidationError("Cannot index a missing object.")
      const current = (await vectors.list({ projectId: ctx.projectId, ref })).find(
        (entry) => entry.profile === profileName
      )
      const input: PreparedObjectVector = {
        projectId: ctx.projectId,
        ref,
        profile: profileName,
        configuration: vectorConfiguration(profileDefinition),
        ...vectorSources(profileDefinition.source, row.properties),
        expectedObject: { ref, exists: true, version: row.version, lastCommitId: row.lastCommitId },
        expectedVectorCommitId: current?.lastCommitId ?? null,
      }

      // Network work never holds a storage transaction or retries an obsolete computation.
      const result = await model.embed({ texts: [input.text] })
      if (!Array.isArray(result?.vectors) || result.vectors.length !== 1) {
        throw new MaterializationValidationError(
          "Embedding model must return exactly one vector for one input text."
        )
      }
      const values = normalizeVector(
        result.vectors[0]!,
        profileDefinition.model.definition.dimensions
      )
      assertCanEdit(ctx, ref.objectTypeId)
      await assertReadable()
      await mutations.commitEdits({
        mode: "atomic",
        source: { kind: "runtime", requestId: randomUUID() },
        operations: [],
        vectorWrites: [{ input, values }],
        expectedObjects: [input.expectedObject],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
  })
}
