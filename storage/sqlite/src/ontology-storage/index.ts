import type { Database } from "bun:sqlite"
import type { OntologyStorage } from "@sixb/core/storage"
import { SqliteOntologyCommitStorage } from "./commits"
import type { SqliteOntologyTransactionContext } from "./materialization-session"
import { SqliteOntologyMaterializationStorage } from "./materializations"
import { SqliteOntologyOutboxStorage } from "./outbox"
import type { SqliteRootOperation } from "./shared"
import { SqliteOntologySourceStorage } from "./sources"

import { SqliteVectorIndexingStorage } from "./vector-indexing"
import { SqliteOntologyVectorStorage } from "./vectors"

export class SqliteOntologyStorage implements OntologyStorage {
  readonly commits: SqliteOntologyCommitStorage
  readonly sources: SqliteOntologySourceStorage
  readonly materializations: SqliteOntologyMaterializationStorage
  readonly vectorIndexing: SqliteVectorIndexingStorage
  readonly vectors: SqliteOntologyVectorStorage
  readonly outbox: SqliteOntologyOutboxStorage

  constructor(input: {
    readonly db: Database
    readonly runRootOperation: SqliteRootOperation
    readonly transactionContext: SqliteOntologyTransactionContext | null
  }) {
    this.commits = new SqliteOntologyCommitStorage(input.db, input.runRootOperation)
    this.sources = new SqliteOntologySourceStorage(input.db, input.runRootOperation)
    this.materializations = new SqliteOntologyMaterializationStorage(
      input.db,
      input.transactionContext
    )
    this.vectorIndexing = new SqliteVectorIndexingStorage(
      input.db,
      input.runRootOperation,
      (session, projectId) => this.materializations.assertVectorSession(session, projectId)
    )
    this.vectors = new SqliteOntologyVectorStorage(
      input.db,
      input.runRootOperation,
      (session, projectId, commitId) =>
        this.materializations.assertVectorSession(session, projectId, commitId)
    )
    this.outbox = new SqliteOntologyOutboxStorage(input.db, input.runRootOperation)
  }

  deactivateSessions(): void {
    this.materializations.deactivateSessions()
  }
}

export type { SqliteOntologyTransactionContext } from "./materialization-session"
