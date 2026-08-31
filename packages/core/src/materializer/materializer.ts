import type { ExecutionScope } from "../execution"
import type {
  EditCommitResult,
  OntologyEditCommit,
  ProjectionCommitResult,
  ProjectionRunFinishInput,
  ProjectionSourceReplacement,
  TelemetryAppend,
  TelemetryCommitResult,
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
import { finishProjectionRun } from "./projections/finish-run"
import { replaceProjection } from "./projections/replace"
import { appendTelemetry } from "./telemetry/append"

export type { MaterializerStorage, OntologyMaterializerDependencies } from "./context"

export interface MaterializerCommand<TInput> {
  readonly scope: ExecutionScope
  readonly input: TInput
}

export interface OntologyMaterializerContract {
  withScope(scope: ExecutionScope): BoundOntologyMaterializer
  readonly edits: {
    commit(input: MaterializerCommand<OntologyEditCommit>): Promise<EditCommitResult>
  }
  readonly projections: {
    replace(
      input: MaterializerCommand<ProjectionSourceReplacement>
    ): Promise<ProjectionCommitResult>
    finishRun(input: MaterializerCommand<ProjectionRunFinishInput>): Promise<void>
  }
  readonly telemetry: {
    append(input: MaterializerCommand<TelemetryAppend>): Promise<TelemetryCommitResult>
  }
}

/** Materializer facade closed over one explicit execution scope. */
export interface BoundOntologyMaterializer {
  readonly edits: {
    commit(input: OntologyEditCommit): Promise<EditCommitResult>
  }
  readonly projections: {
    replace(input: ProjectionSourceReplacement): Promise<ProjectionCommitResult>
    finishRun(input: ProjectionRunFinishInput): Promise<void>
  }
  readonly telemetry: {
    append(input: TelemetryAppend): Promise<TelemetryCommitResult>
  }
}

export class OntologyMaterializer implements OntologyMaterializerContract {
  readonly edits = {
    commit: (command: MaterializerCommand<OntologyEditCommit>) =>
      commitEdits(this.context, command),
  }
  readonly projections = {
    replace: (command: MaterializerCommand<ProjectionSourceReplacement>) =>
      replaceProjection(this.context, command),
    finishRun: (command: MaterializerCommand<ProjectionRunFinishInput>) =>
      finishProjectionRun(this.context, command),
  }
  readonly telemetry = {
    append: (command: MaterializerCommand<TelemetryAppend>) =>
      appendTelemetry(this.context, command),
  }

  withScope(scope: ExecutionScope): BoundOntologyMaterializer {
    return Object.freeze({
      edits: Object.freeze({
        commit: (input: OntologyEditCommit) => this.edits.commit({ scope, input }),
      }),
      projections: Object.freeze({
        replace: (input: ProjectionSourceReplacement) => this.projections.replace({ scope, input }),
        finishRun: (input: ProjectionRunFinishInput) =>
          this.projections.finishRun({ scope, input }),
      }),
      telemetry: Object.freeze({
        append: (input: TelemetryAppend) => this.telemetry.append({ scope, input }),
      }),
    })
  }

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
