import { canViewPrimitiveRun, isRuntimeAllowed } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type {
  DatasetProducer,
  DatasetVersion,
  DatasetVersionRef,
  LakeStorage,
} from "../lake-storage/types"
import type { SixbRuntimeContext } from "../runtime/types"

const DEFAULT_LINEAGE_DEPTH = 5
const MAX_LINEAGE_DEPTH = 20

/** Most versions one walk returns, the starting version included. It bounds the lake reads too. */
export const MAX_DATASET_LINEAGE_NODES = 100

export interface DatasetLineageInput {
  /** Defaults to the latest version. */
  readonly versionId?: string
  /** How many input steps to follow upstream, from 1 to 20. Defaults to 5. */
  readonly depth?: number
}

/** The versions a dataset version is computed from, as far upstream as the reader may see. */
export interface DatasetLineage {
  /** The starting version first, then each version the walk reached, nearest first. */
  readonly nodes: readonly DatasetLineageNode[]
  /** One per input relation between two nodes. */
  readonly edges: readonly DatasetLineageEdge[]
  /** Versions left out because the reader cannot view their dataset. Their inputs are not walked. */
  readonly restricted: number
  /** Whether the walk stopped at `depth` or at the node cap with inputs left to follow. */
  readonly truncated: boolean
}

export type DatasetLineageNode = DatasetLineageVersion | DatasetLineageExpiredVersion

export interface DatasetLineageVersion extends DatasetVersionRef {
  readonly mode: DatasetVersion["mode"]
  readonly createdAt: Date
  /** The version this one builds on. The walk follows inputs, not parents. */
  readonly parentVersionId?: string
  /**
   * What wrote the version. A sync or pipeline producer names its definition and run only to a
   * reader who may view that sync's or pipeline's runs; an ingest producer only gives its kind.
   */
  readonly producer?: DatasetProducer
}

/** An input version the lake no longer holds, for example one that expired. It is not walked. */
export interface DatasetLineageExpiredVersion extends DatasetVersionRef {
  readonly expired: true
}

export interface DatasetLineageEdge {
  /** The input version. */
  readonly from: DatasetVersionRef
  /** The version computed from it. */
  readonly to: DatasetVersionRef
}

/** The requested depth once validated, or the default. */
export function datasetLineageDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_LINEAGE_DEPTH

  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_LINEAGE_DEPTH) {
    throw new Error(
      `[Sixb] Dataset lineage depth must be an integer between 1 and ${MAX_LINEAGE_DEPTH}, received ${depth}.`
    )
  }

  return depth
}

/**
 * Walk a version's inputs upstream, one step at a time, for a reader who may view its dataset.
 *
 * Each upstream version is authorized on its own: a version whose dataset the reader cannot view
 * is counted in `restricted` and neither read nor walked through, so nothing upstream of it shows.
 */
export async function walkDatasetLineage(
  runtime: SixbRuntimeContext,
  lakeStorage: Pick<LakeStorage, "getVersion">,
  root: DatasetVersion,
  depth: number
): Promise<DatasetLineage> {
  const canViewDataset = (datasetId: string) =>
    isRuntimeAllowed(runtime, { kind: "dataset.view", datasetId })

  const nodes = new Map<string, DatasetLineageNode>([
    [versionKey(root), lineageVersion(runtime, root)],
  ])
  const hidden = new Set<string>()
  const edges: DatasetLineageEdge[] = []
  let truncated = false
  let frontier: readonly DatasetVersion[] = [root]

  for (let step = 1; frontier.length > 0; step++) {
    const reached = new Map<string, DatasetVersionRef>()

    for (const version of frontier) {
      for (const input of distinctInputs(version)) {
        const key = versionKey(input)
        if (hidden.has(key)) continue

        if (!nodes.has(key) && !reached.has(key)) {
          if (step > depth || nodes.size + reached.size >= MAX_DATASET_LINEAGE_NODES) {
            truncated = true
            continue
          }

          if (!canViewDataset(input.datasetId)) {
            hidden.add(key)
            continue
          }

          reached.set(key, input)
        }

        edges.push({ from: versionRef(input), to: versionRef(version) })
      }
    }

    // The versions of one step are read together; the node cap bounds how many there are.
    const refs = [...reached.values()]
    const versions = await Promise.all(
      refs.map((ref) => lakeStorage.getVersion(ref.datasetId, ref.versionId))
    )

    frontier = versions.filter((version) => version !== null)
    refs.forEach((ref, index) => {
      const version = versions[index]
      nodes.set(
        versionKey(ref),
        version ? lineageVersion(runtime, version) : { ...versionRef(ref), expired: true }
      )
    })
  }

  return { nodes: [...nodes.values()], edges, restricted: hidden.size, truncated }
}

function lineageVersion(
  runtime: SixbRuntimeContext,
  version: DatasetVersion
): DatasetLineageVersion {
  return {
    ...versionRef(version),
    mode: version.mode,
    createdAt: version.createdAt,
    ...(version.parentVersionId === undefined ? {} : { parentVersionId: version.parentVersionId }),
    ...(version.producer === undefined
      ? {}
      : { producer: visibleProducer(runtime, version.producer) }),
  }
}

/** The producer as the reader may see it, decided as the pipeline and sync run facades decide. */
function visibleProducer(runtime: SixbRuntimeContext, producer: DatasetProducer): DatasetProducer {
  const { kind, id } = producer
  if (id === undefined || kind === "ingest") return { kind }

  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const visible =
    authority.type === "unrestricted" ||
    (authority.type === "principal" && canViewPrimitiveRun(authority.context, { kind, id }))

  if (!visible) return { kind }

  return {
    kind,
    id,
    ...(producer.runId === undefined ? {} : { runId: producer.runId }),
    ...(producer.stepId === undefined ? {} : { stepId: producer.stepId }),
  }
}

/** A version's inputs, each once, in the order it lists them. */
function distinctInputs(version: DatasetVersion): DatasetVersionRef[] {
  const inputs = new Map<string, DatasetVersionRef>()
  for (const input of version.inputs ?? []) inputs.set(versionKey(input), input)
  return [...inputs.values()]
}

function versionRef(ref: DatasetVersionRef): DatasetVersionRef {
  return { datasetId: ref.datasetId, versionId: ref.versionId }
}

function versionKey(ref: DatasetVersionRef): string {
  return JSON.stringify([ref.datasetId, ref.versionId])
}
