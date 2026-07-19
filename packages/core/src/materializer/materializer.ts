import type {
  OntologyEditCommit,
  OntologyMaterializer as OntologyMaterializerContract,
  ProjectionSourceReplacement,
  TelemetryAppend,
} from "../materialization/model"
import type { OntologyRegistry } from "../ontology"
import type { ProjectionRegistry } from "../projections/registry"
import {
  createMaterializerContext,
  type MaterializerContext,
  type MaterializerStorage,
  type OntologyMaterializerDependencies,
} from "./context"
import { commitEdits } from "./edits/commit"
import { replaceProjection } from "./projections/replace"
import { appendTelemetry } from "./telemetry/append"

export type { MaterializerStorage, OntologyMaterializerDependencies } from "./context"

export class OntologyMaterializer implements OntologyMaterializerContract {
  readonly edits = { commit: (input: OntologyEditCommit) => commitEdits(this.context, input) }
  readonly projections = {
    replace: (input: ProjectionSourceReplacement) => replaceProjection(this.context, input),
  }
  readonly telemetry = { append: (input: TelemetryAppend) => appendTelemetry(this.context, input) }

  private readonly context: MaterializerContext

  constructor(
    projectId: string,
    ontology: OntologyRegistry,
    projectionRegistry: ProjectionRegistry,
    storage: MaterializerStorage,
    dependencies: OntologyMaterializerDependencies = {}
  ) {
    this.context = createMaterializerContext({
      projectId,
      ontology,
      projections: projectionRegistry,
      storage,
      dependencies,
    })
  }
}

export function createOntologyMaterializer(input: {
  readonly projectId: string
  readonly ontology: OntologyRegistry
  readonly projections: ProjectionRegistry
  readonly storage: MaterializerStorage
  readonly dependencies?: OntologyMaterializerDependencies
}): OntologyMaterializer {
  return new OntologyMaterializer(
    input.projectId,
    input.ontology,
    input.projections,
    input.storage,
    input.dependencies
  )
}
