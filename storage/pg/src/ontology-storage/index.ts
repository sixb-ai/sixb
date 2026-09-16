import type { OntologyStorage } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { PgOntologyCommitStorage } from "./commits"
import type { PgOntologyTransactionContext } from "./materialization-session"
import { PgOntologyMaterializationStorage } from "./materializations"
import { PgOntologyOutboxStorage } from "./outbox"
import type { PgRootOperation } from "./shared"
import { PgOntologySourceStorage } from "./sources"
import { PgOntologyVectorStorage } from "./vectors"

export class PgOntologyStorage implements OntologyStorage {
  readonly commits: PgOntologyCommitStorage
  readonly sources: PgOntologySourceStorage
  readonly materializations: PgOntologyMaterializationStorage
  readonly outbox: PgOntologyOutboxStorage
  readonly vectors: PgOntologyVectorStorage

  constructor(input: {
    readonly sql: SQLClient
    readonly runRootOperation: PgRootOperation
    readonly transactionContext: PgOntologyTransactionContext | null
  }) {
    this.commits = new PgOntologyCommitStorage(input.runRootOperation)
    this.sources = new PgOntologySourceStorage(input.runRootOperation)
    this.materializations = new PgOntologyMaterializationStorage(
      input.sql,
      input.transactionContext
    )
    this.outbox = new PgOntologyOutboxStorage(input.runRootOperation)
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
