import type { ExecutionScope } from "../execution/types"
import type { OntologyRegistry } from "../ontology"
import {
  isSnapshotCopyStorage,
  type SnapshotCopyCounts,
  type SnapshotCopyType,
} from "../storage/snapshots"
import type { Storage } from "../storage/types"
import type { BranchDefinitions } from "./definitions"
import {
  APPLIED_MARKINGS_ATTEMPTS,
  appliedMoved,
  pinnedReader,
  type SnapshotSource,
  snapshotManifest,
} from "./export"
import { baseCommit, ImportPlan, report, type SnapshotImportReport } from "./import"

export interface CopySnapshotInput {
  readonly source: SnapshotSource
  /** The person the snapshot is taken as. */
  readonly scope: ExecutionScope
  /**
   * The branch's storage: a namespace production created, which holds no object yet and which
   * nothing but production has used.
   */
  readonly storage: Storage
  /** The branch's definitions, as data: production never loads the branch's code. */
  readonly definitions: BranchDefinitions
  /** How long production keeps its read open. Defaults to 30 minutes. */
  readonly maxDurationMs?: number
}

const DEFAULT_MAX_DURATION_MS = 30 * 60_000

/**
 * A snapshot copied from production into a branch's storage inside the engine, holding exactly
 * what importing the exported snapshot would: when the storage copies from production's, and the
 * person reads every object, property and link of each type they read.
 *
 * `undefined` when it does not apply: take the snapshot as a file, and let the branch import it.
 */
export async function copySnapshot(
  input: CopySnapshotInput
): Promise<SnapshotImportReport | undefined> {
  const { source, definitions, storage: target } = input
  if (!isSnapshotCopyStorage(target) || !target.copiesFrom(source.storage)) return undefined

  for (let attempt = 1; attempt <= APPLIED_MARKINGS_ATTEMPTS; attempt += 1) {
    const { scope, user, pinnedSources } = await pinnedReader(source, input.scope)
    const whole = [...scope.types.values()].every(
      (type) =>
        !type.throughCondition &&
        type.hiddenPropertyIds.length === 0 &&
        type.hiddenLinkIds.length === 0
    )
    if (!whole) return undefined

    let prepared: Prepared | undefined
    const counts = await target.copySnapshot({
      source: source.storage,
      projectId: source.projectId,
      maxDurationMs: input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      prepare: async (at) => {
        const active = await at.ontology.sources.listActive({ projectId: source.projectId })
        if (appliedMoved(source, pinnedSources, active)) return undefined

        const manifest = {
          ...snapshotManifest(source, { ...scope, user }, active, {
            vectorConfigurations: undefined,
          }),
          takenAt: new Date().toISOString(),
        }
        const plan = new ImportPlan(manifest, definitions)
        const commit = await baseCommit(target, manifest, definitions)
        prepared = { plan, manifest, commitId: commit.id }

        return {
          commit,
          uniqueProperties: plan.uniqueProperties(),
          types: copyTypes(plan, source.ontology),
          members: scope.canViewUsers ? "all" : [user.id],
        }
      },
    })

    if (counts && prepared) return copyReport(prepared, counts)
  }

  throw new Error(
    "[Sixb] Projections kept applying new dataset versions while the copy started: take it again once they settle."
  )
}

/** What the branch keeps of each type that fits it, as the storage copies it. */
function copyTypes(plan: ImportPlan, production: OntologyRegistry): SnapshotCopyType[] {
  const fitting = plan.objectTypeIds()

  return fitting.map((objectTypeId) => {
    const type = plan.type(objectTypeId)!
    const profiles = production.resolveObjectType(objectTypeId).search?.vectors ?? {}

    return {
      objectTypeId,
      droppedPropertyIds: [...type.droppedPropertyIds],
      telemetryPropertyIds: [...type.telemetryPropertyIds],
      uniquePropertyIds: type.unique.map((property) => property.propertyId),
      artifactPropertyIds: [...type.definition.artifactPropertyIds],
      links: Object.keys(type.manifest.links).flatMap((linkId) =>
        fitting
          .filter((targetTypeId) => plan.keepsLink(type, linkId, targetTypeId))
          .map((targetTypeId) => ({
            linkId,
            targetTypeId,
            identity: plan.linkIdentity(type, linkId),
          }))
      ),
      vectors: type.manifest.vectors.flatMap(({ profile, configuration }) => {
        const definition = profiles[profile]
        if (!definition) return []

        return [
          {
            profile,
            configuration,
            source: [...definition.source],
            dimensions: definition.model.definition.dimensions,
            copy: plan.skipsVectors(type, profile, configuration) === undefined,
          },
        ]
      }),
    }
  })
}

interface Prepared {
  readonly plan: ImportPlan
  readonly manifest: Parameters<typeof report>[0]
  readonly commitId: string
}

/** The report importing the snapshot would give, from what the storage copied. */
function copyReport(
  { plan, manifest, commitId }: Prepared,
  counts: SnapshotCopyCounts
): SnapshotImportReport {
  for (const objectTypeId of plan.objectTypeIds()) {
    const type = plan.type(objectTypeId)!
    const copied = counts.types.get(objectTypeId)
    if (!copied) continue

    type.counts.objects = copied.objects
    type.counts.links = copied.links
    type.counts.droppedLinks = copied.droppedLinks
    type.counts.points = copied.points

    for (const { profile, configuration } of type.manifest.vectors) {
      const count = copied.vectors.get(profile) ?? 0
      if (count === 0) continue

      const skipped = plan.skipsVectors(type, profile, configuration)
      if (skipped) type.skippedVectors.set(profile, skipped)
      else type.counts.vectors += count
    }
  }

  return report(manifest, plan, commitId, counts.users)
}
