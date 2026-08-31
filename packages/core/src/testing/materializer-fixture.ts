import { createTestingScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import type {
  EditCommitResult,
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyObjectRef,
  TelemetryCommitResult,
  TelemetryPointWrite,
} from "../materialization/model"
import {
  type BoundOntologyMaterializer,
  createOntologyMaterializer,
  type OntologyMaterializerDependencies,
} from "../materializer/materializer"
import type { OntologyRegistry } from "../ontology"
import { ProjectionRegistry } from "../projections/registry"
import type { Storage } from "../storage"

export interface MaterializerFixtureObject {
  readonly ref: OntologyObjectRef
  readonly properties: Readonly<Record<string, JsonValue>>
}

export interface MaterializerFixtureLink {
  readonly ref: OntologyLinkRef
  readonly properties?: Readonly<Record<string, JsonValue>>
}

export interface MaterializerFixtureSeed {
  readonly objects?: readonly MaterializerFixtureObject[]
  readonly links?: readonly MaterializerFixtureLink[]
  readonly telemetry?: readonly TelemetryPointWrite[]
}

export interface MaterializerTestFixture {
  readonly materializer: BoundOntologyMaterializer
  commit(operations: readonly OntologyEditOperation[]): Promise<EditCommitResult>
  appendTelemetry(points: readonly TelemetryPointWrite[]): Promise<TelemetryCommitResult>
  seed(input: MaterializerFixtureSeed): Promise<void>
}

/**
 * Creates data for storage/query tests through the same validated Materializer path as production.
 * It intentionally exposes no direct storage writer.
 */
export function createMaterializerTestFixture(input: {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly storage: Storage
  readonly dependencies?: OntologyMaterializerDependencies
}): MaterializerTestFixture {
  const projections = new ProjectionRegistry({
    projections: [],
    ontology: input.ontology,
    datasetsById: new Map(),
  })
  const materializer = createOntologyMaterializer({
    projectId: input.projectId,
    ontology: input.ontology,
    projections,
    storage: input.storage,
    dependencies: input.dependencies,
  }).withScope(
    createTestingScope({
      projectId: input.projectId,
      executionId: `materializer_fixture_execution:${input.projectId}`,
      requestId: `materializer_fixture_request:${input.projectId}`,
      correlationId: `materializer_fixture_correlation:${input.projectId}`,
    })
  )
  let requestOrdinal = 0

  function nextRequestId(kind: "edit" | "telemetry"): string {
    requestOrdinal += 1
    return `materializer-fixture:${kind}:${requestOrdinal}`
  }

  async function commit(operations: readonly OntologyEditOperation[]): Promise<EditCommitResult> {
    return materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: nextRequestId("edit") },
      operations,
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
  }

  async function appendTelemetry(
    points: readonly TelemetryPointWrite[]
  ): Promise<TelemetryCommitResult> {
    return materializer.telemetry.append({
      source: { kind: "runtime", requestId: nextRequestId("telemetry") },
      points,
    })
  }

  return {
    materializer,
    commit,
    appendTelemetry,
    async seed(seed) {
      const operations: OntologyEditOperation[] = []
      for (const object of seed.objects ?? []) {
        operations.push({
          id: `seed-object:${operations.length}`,
          kind: "object.upsert",
          ref: object.ref,
          properties: object.properties,
        })
      }
      for (const link of seed.links ?? []) {
        operations.push({
          id: `seed-link:${operations.length}`,
          kind: "link.upsert",
          ref: link.ref,
          ...(link.properties === undefined ? {} : { properties: link.properties }),
        })
      }
      if (operations.length > 0) await commit(operations)
      if (seed.telemetry && seed.telemetry.length > 0) {
        await appendTelemetry(seed.telemetry)
      }
    },
  }
}
