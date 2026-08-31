import { createSixbError } from "@sixb/core/internal/errors"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { ProjectionDispatcherPort, ProjectionReconciliationPorts } from "./types"

const RECONCILIATION_INTERVAL_MS = 30_000

interface ProjectionDispatchReconcilerInput extends ProjectionReconciliationPorts {
  readonly projectId: string
  readonly dispatcher: ProjectionDispatcherPort
  readonly descriptors: readonly ProjectionDispatchDescriptor[]
}

export async function runProjectionDispatchReconciler(
  input: ProjectionDispatchReconcilerInput,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    await reconcileProjectionDispatch(input)
    await waitForNextPass(signal)
  }
}

export async function reconcileProjectionDispatch(
  input: ProjectionDispatchReconcilerInput
): Promise<void> {
  for (const descriptor of input.descriptors) {
    try {
      await reconcileProjection(input, descriptor)
    } catch (error) {
      console.error(
        `[SixbOrchestrator] Projection dispatch reconciliation failed (projectionId=${descriptor.projectionId}, datasetId=${descriptor.datasetId}):`,
        error
      )
    }
  }
}

async function reconcileProjection(
  input: ProjectionDispatchReconcilerInput,
  descriptor: ProjectionDispatchDescriptor
): Promise<void> {
  const version = await findLatestDataVersion({
    lakeStorage: input.lakeStorage,
    projectId: input.projectId,
    projectionId: descriptor.projectionId,
    datasetId: descriptor.datasetId,
  })
  if (!version) return

  await input.dispatcher.dispatch({
    projectionId: descriptor.projectionId,
    datasetVersion: pinnedVersion(version),
    metadata: { dispatchSource: "lake-reconciliation" },
  })
}

async function findLatestDataVersion(input: {
  readonly lakeStorage: ProjectionReconciliationPorts["lakeStorage"]
  readonly projectId: string
  readonly projectionId: string
  readonly datasetId: string
}): Promise<DatasetVersion | null> {
  let version = await input.lakeStorage.getLatestVersion(input.datasetId)
  const visited = new Set<string>()

  while (version?.mode === "schema") {
    if (!version.parentVersionId) {
      const versions = await input.lakeStorage.listVersions(input.datasetId)
      return versions.find((candidate) => candidate.mode !== "schema") ?? null
    }
    if (visited.has(version.versionId)) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbOrchestrator] Dataset '${input.datasetId}' version ancestry contains a cycle at '${version.versionId}'.`,
        {
          details: {
            projectId: input.projectId,
            projectionId: input.projectionId,
            datasetId: input.datasetId,
            versionId: version.versionId,
          },
        }
      )
    }
    visited.add(version.versionId)
    const schemaVersionId = version.versionId
    const parentVersionId = version.parentVersionId
    version = await input.lakeStorage.getVersion(input.datasetId, parentVersionId)
    if (!version) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbOrchestrator] Dataset '${input.datasetId}' schema version references missing parent '${parentVersionId}'.`,
        {
          details: {
            projectId: input.projectId,
            projectionId: input.projectionId,
            datasetId: input.datasetId,
            versionId: schemaVersionId,
            parentVersionId,
          },
        }
      )
    }
  }

  return version
}

function pinnedVersion(version: DatasetVersion) {
  return {
    datasetId: version.datasetId,
    versionId: version.versionId,
    createdAt: version.createdAt.toISOString(),
  }
}

async function waitForNextPass(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, RECONCILIATION_INTERVAL_MS)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
