import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryStorage,
  link,
  OntologyRegistry,
  prop,
} from "../src"
import { restoreTrustedPrimitiveExecutionScope } from "../src/execution/durable"
import { createTestingScope } from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import {
  createOntologyMaterializer,
  type OntologyMaterializerDependencies,
  type PinnedDatasetVersion,
  type ProjectionExecution,
  ProjectionRegistry,
  type ProjectionSourceEntry,
  type ProjectionSourceReplacement,
  type TelemetryAppend,
} from "../src/materializer"
import { claimTestProjectionRun, createTestActionExecution } from "../src/testing"

export const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
    prop("note", "string", { nullable: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link.self("parent", { cardinality: "one" }), link.self("peers", { cardinality: "many" })],
})

const devices = defineDataset("devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("note", "string", { nullable: true }),
    col("parent_id", "string", { nullable: true }),
  ],
})
const readings = defineDataset("readings", {
  schema: [col("device_id", "string"), col("at", "timestamp"), col("value", "float64")],
})
const deviceProjection = defineProjection("devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name", note: "note" })
  .withLinks({
    parent: {
      link: Device.l.parent,
      sourceField: "parent_id",
      target: Device,
    },
  })
const temperatureProjection = defineProjection("temperatures", Device.p.temperature)
  .fromDataset(readings)
  .points({ objectId: "device_id", at: "at", value: "value" })

export function createMaterializerFixture(
  input: {
    readonly dependencies?: OntologyMaterializerDependencies
    readonly storage?: InMemoryStorage
    readonly scope?: ExecutionScope
  } = {}
) {
  const ontology = new OntologyRegistry({ sources: [Device] })
  const projections = new ProjectionRegistry({
    projections: [deviceProjection, temperatureProjection],
    ontology,
    datasetsById: new Map<string, DatasetDefinition>([
      [devices.id, devices],
      [readings.id, readings],
    ]),
  })
  const storage = input.storage ?? new InMemoryStorage()
  const baseMaterializer = createOntologyMaterializer({
    projectId: "project",
    ontology,
    projections,
    storage,
    dependencies: {
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      materializationId: materializationSequence(),
      ...input.dependencies,
    },
  })
  const runtimeMaterializer = baseMaterializer.withScope(
    input.scope ??
      createTestingScope({
        projectId: "project",
        executionId: "materializer-fixture-runtime-execution",
        requestId: "materializer-fixture-runtime-request",
        correlationId: "materializer-fixture-runtime-correlation",
      })
  )
  const materializer = {
    edits: {
      async commit(request: Parameters<typeof runtimeMaterializer.edits.commit>[0]) {
        if (request.source.kind !== "action") return runtimeMaterializer.edits.commit(request)
        const scope = await actionScope(storage, request.source.actionId, request.source.runId)
        return baseMaterializer.withScope(scope).edits.commit(request)
      },
    },
    projections: {
      async replace(request: ProjectionSourceReplacement) {
        const execution = await resolveFixtureExecution(storage, projections, request.execution, {
          projectionId: request.source.projectionId,
          protocol: "replacement",
          datasetVersion: request.datasetVersion,
        })
        const scope = await projectionScope(storage, {
          projectId: "project",
          projectionId: request.source.projectionId,
          runId: execution.projectionRunId,
        })
        return baseMaterializer.withScope(scope).projections.replace({ ...request, execution })
      },
      async finishRun(request: Parameters<typeof runtimeMaterializer.projections.finishRun>[0]) {
        const scope = await projectionScope(storage, {
          projectId: "project",
          projectionId: request.source.projectionId,
          runId: request.execution.projectionRunId,
        })
        return baseMaterializer.withScope(scope).projections.finishRun(request)
      },
    },
    telemetry: {
      async append(request: TelemetryAppend) {
        if (request.source.kind !== "projection") {
          return runtimeMaterializer.telemetry.append(request)
        }
        if (request.source.execution.executionToken !== FIXTURE_EXECUTION_TOKEN) {
          const scope = await projectionScope(storage, {
            projectId: "project",
            projectionId: request.source.projection.projectionId,
            runId: request.source.execution.projectionRunId,
          })
          return baseMaterializer.withScope(scope).telemetry.append(request)
        }
        const execution = await claimProjectionExecution(storage, projections, {
          runId: request.source.execution.projectionRunId,
          projectionId: request.source.projection.projectionId,
          protocol: "telemetry",
          datasetVersion: request.source.datasetVersion,
          fixedBatchSize: request.source.sourceRowCount,
        })
        const scope = await projectionScope(storage, {
          projectId: "project",
          projectionId: request.source.projection.projectionId,
          runId: execution.projectionRunId,
        })
        return baseMaterializer.withScope(scope).telemetry.append({
          ...request,
          source: { ...request.source, execution },
        })
      },
    },
  }
  return { materializer, storage, ontology, projections }
}

async function actionScope(
  storage: InMemoryStorage,
  actionId: string,
  runId: string
): Promise<ExecutionScope> {
  const run = await storage.actionRuns?.getById({ projectId: "project", id: runId })
  const executionId =
    run?.executionId ??
    (await createTestActionExecution(storage.executions, {
      projectId: "project",
      actionId,
      runId,
    }))
  const execution = await storage.executions.getById({ projectId: "project", id: executionId })
  if (!execution) throw new Error(`Action execution '${executionId}' is missing.`)
  return restoreTrustedPrimitiveExecutionScope({
    execution,
    primitive: { kind: "action", id: actionId, runId },
  })
}

export async function projectionScope(
  storage: InMemoryStorage,
  input: {
    readonly projectId: string
    readonly projectionId: string
    readonly runId: string
  }
): Promise<ExecutionScope> {
  const run = await storage.projectionRuns?.getById({
    projectId: input.projectId,
    id: input.runId,
  })
  if (!run) throw new Error(`Projection run '${input.runId}' is not available in the fixture.`)
  const execution = await storage.executions.getById({
    projectId: input.projectId,
    id: run.executionId,
  })
  if (!execution) throw new Error(`Projection execution '${run.executionId}' is missing.`)
  return restoreTrustedPrimitiveExecutionScope({
    execution,
    primitive: { kind: "projection", id: input.projectionId, runId: input.runId },
  })
}

export function sourceEntry(id: string, name: string, note?: string | null): ProjectionSourceEntry {
  return {
    root: { kind: "object", ref: { objectTypeId: "Device", primaryId: id } },
    assertions: [
      {
        kind: "object",
        ref: { objectTypeId: "Device", primaryId: id },
        properties: { name, ...(note !== undefined ? { note } : {}) },
      },
    ],
  }
}

export function sourceEntryWithParent(
  id: string,
  name: string,
  parentId: string
): ProjectionSourceEntry {
  const object = sourceEntry(id, name)
  return {
    ...object,
    assertions: [
      ...object.assertions,
      {
        kind: "link",
        ref: {
          source: { objectTypeId: "Device", primaryId: id },
          linkId: "parent",
          target: { objectTypeId: "Device", primaryId: parentId },
        },
      },
    ],
  }
}

export async function* entries(
  values: readonly ProjectionSourceEntry[]
): AsyncIterable<ProjectionSourceEntry> {
  for (const value of values) yield value
}

export function replacement(
  versionId: string,
  createdAt: string,
  values: readonly ProjectionSourceEntry[],
  runId = `run-${versionId}`
) {
  return {
    source: { projectionId: "devices" },
    datasetVersion: { datasetId: "devices", versionId, createdAt },
    execution: pendingProjectionExecution(runId),
    entries: entries(values),
  } as const
}

const FIXTURE_EXECUTION_TOKEN = "__fixture_claim__"

export function pendingProjectionExecution(projectionRunId: string): ProjectionExecution {
  return { projectionRunId, executionToken: FIXTURE_EXECUTION_TOKEN }
}

export async function claimProjectionExecution(
  storage: InMemoryStorage,
  projections: ProjectionRegistry,
  input: {
    readonly runId: string
    readonly projectionId: string
    readonly protocol: "replacement" | "telemetry"
    readonly datasetVersion: PinnedDatasetVersion
    readonly fixedBatchSize?: number
  }
): Promise<ProjectionExecution> {
  const resolved =
    input.protocol === "replacement"
      ? projections.resolveSource(input.projectionId)
      : projections.resolveTelemetry(input.projectionId)
  const definition = resolved.definition
  const identityBase = {
    projectionId: resolved.projectionId,
    datasetVersion: {
      ...input.datasetVersion,
      createdAt: new Date(input.datasetVersion.createdAt).toISOString(),
    },
    ontologyRevision: projections.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
  const common = { id: input.runId, projectId: "project" } as const
  if (definition._tag === "TelemetryProjectionDefinition") {
    const claim = await claimTestProjectionRun(storage, {
      ...common,
      identity: { ...identityBase, projectionKind: "telemetry", protocol: "telemetry" },
      target: { objectTypeId: definition.objectTypeId },
      fixedBatchSize: input.fixedBatchSize ?? 1,
    })
    return claim.execution
  }
  if (input.protocol !== "replacement") {
    throw new Error("Telemetry execution requires a telemetry projection")
  }
  if (definition._tag === "LinkProjectionDefinition") {
    const claim = await claimTestProjectionRun(storage, {
      ...common,
      identity: { ...identityBase, projectionKind: "link", protocol: "replacement" },
      target: {
        sourceObjectTypeId: definition.sourceObjectTypeId,
        targetObjectTypeId: definition.targetObjectTypeId,
      },
    })
    return claim.execution
  }
  const claim = await claimTestProjectionRun(storage, {
    ...common,
    identity: { ...identityBase, projectionKind: "object", protocol: "replacement" },
    target: { objectTypeId: definition.objectTypeId },
  })
  return claim.execution
}

async function resolveFixtureExecution(
  storage: InMemoryStorage,
  projections: ProjectionRegistry,
  execution: ProjectionExecution,
  input: {
    readonly projectionId: string
    readonly protocol: "replacement" | "telemetry"
    readonly datasetVersion: PinnedDatasetVersion
  }
): Promise<ProjectionExecution> {
  if (execution.executionToken !== FIXTURE_EXECUTION_TOKEN) return execution
  return claimProjectionExecution(storage, projections, {
    ...input,
    runId: execution.projectionRunId,
  })
}

export function atomic(
  requestId: string,
  operations: readonly import("../src/materializer").OntologyEditOperation[]
) {
  return {
    mode: "atomic",
    source: { kind: "runtime", requestId },
    operations,
    expectedObjects: [],
    expectedLinks: [],
    expectedLinkScopes: [],
  } as const
}

function materializationSequence(): () => string {
  let value = 0
  return () => `materialization-${++value}`
}
