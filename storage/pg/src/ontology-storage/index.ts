import type { OntologyStorage } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { PgOntologyCommitStorage } from "./commits"
import type { PgOntologyTransactionContext } from "./materialization-session"
import { PgOntologyMaterializationStorage } from "./materializations"
import { PgOntologyMigrationStorage } from "./migrations"
import { PgOntologyOutboxStorage } from "./outbox"
import { PgOntologyReplacementPlanStorage } from "./replacement-plans"
import type { PgRootOperation } from "./shared"
import { PgOntologySourceStorage } from "./sources"
import { PgOntologyTypeShapeStorage } from "./type-shapes"
import { PgOntologyUniqueValueStorage } from "./unique-values"
import { PgVectorIndexingStorage } from "./vector-indexing"
import { PgOntologyVectorStorage } from "./vectors"

export class PgOntologyStorage implements OntologyStorage {
  readonly commits: PgOntologyCommitStorage
  readonly sources: PgOntologySourceStorage
  readonly materializations: PgOntologyMaterializationStorage
  readonly replacementPlans: PgOntologyReplacementPlanStorage
  readonly outbox: PgOntologyOutboxStorage
  readonly vectorIndexing: PgVectorIndexingStorage
  readonly vectors: PgOntologyVectorStorage
  readonly uniqueValues: PgOntologyUniqueValueStorage
  readonly typeShapes: PgOntologyTypeShapeStorage
  readonly migrations: PgOntologyMigrationStorage

  constructor(input: {
    readonly sql: SQLClient
    readonly runRootOperation: PgRootOperation
    readonly transactionContext: PgOntologyTransactionContext | null
    /** The pool's connections, which bound how many migration lanes run side by side. */
    readonly poolSize: number
  }) {
    this.commits = new PgOntologyCommitStorage(input.runRootOperation)
    this.sources = new PgOntologySourceStorage(input.runRootOperation)
    this.materializations = new PgOntologyMaterializationStorage(
      input.sql,
      input.transactionContext
    )
    this.replacementPlans = new PgOntologyReplacementPlanStorage(input.sql)
    this.outbox = new PgOntologyOutboxStorage(input.runRootOperation)
    this.uniqueValues = new PgOntologyUniqueValueStorage(input.runRootOperation)
    this.typeShapes = new PgOntologyTypeShapeStorage(input.runRootOperation)
    this.migrations = new PgOntologyMigrationStorage(input.runRootOperation, input.poolSize)
    this.vectorIndexing = new PgVectorIndexingStorage(
      input.sql,
      input.runRootOperation,
      (session, projectId) => this.materializations.assertVectorSession(session, projectId)
    )
    this.vectors = new PgOntologyVectorStorage(
      input.sql,
      input.runRootOperation,
      (session, projectId, commitId) =>
        this.materializations.assertVectorSession(session, projectId, commitId)
    )
  }

  deactivateSessions(): void {
    this.materializations.deactivateSessions()
  }
}

export type { PgOntologyTransactionContext } from "./materialization-session"
