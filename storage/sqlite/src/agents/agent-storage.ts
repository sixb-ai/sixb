import type { AgentStorage, ExecutionStorage } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "../migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "../transactions"
import { SqliteAgentContextCheckpointStore } from "./checkpoints"
import { SqliteAgentMessageStore } from "./messages"
import { SqliteAgentRunStore } from "./runs"
import { SqliteAgentThreadStore } from "./threads"

export interface SqliteAgentStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
  /** Execution ledger used to validate immutable run ownership. */
  executions: ExecutionStorage
}

/**
 * SQLite-backed agent persistence: thread, run, message, and context-checkpoint sub-stores sharing
 * one connection. Cross-table writes run in SQLite transactions; the bundled {@link SqliteStorage}
 * serializes them for single-flight and checkpoint compare-and-swap safety.
 */
export class SqliteAgentStorage implements AgentStorage {
  readonly threads: SqliteAgentThreadStore
  readonly runs: SqliteAgentRunStore
  readonly messages: SqliteAgentMessageStore
  readonly checkpoints: SqliteAgentContextCheckpointStore

  private readonly connection: SqliteStoreConnection

  constructor(options: SqliteAgentStorageOptions) {
    this.connection = openSqliteStoreConnection(options)

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }

    this.threads = new SqliteAgentThreadStore(this.connection.db)
    this.runs = new SqliteAgentRunStore(this.connection.db, options.executions)
    this.messages = new SqliteAgentMessageStore(this.connection.db)
    this.checkpoints = new SqliteAgentContextCheckpointStore(this.connection.db)
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}
