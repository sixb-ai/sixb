import type { AgentStorage } from "@sixb/core"
import { installFreshSqliteSchema } from "../migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "../transactions"
import { SqliteAgentMessageStore } from "./messages"
import { SqliteAgentRunStore } from "./runs"
import { SqliteAgentThreadStore } from "./threads"

export interface SqliteAgentStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

/**
 * SQLite-backed agent persistence: thread / run / message sub-stores sharing one connection. The
 * cross-table writes (reserve + finish touch the thread anchor, append bumps thread stats) run in
 * SQLite transactions; the bundled {@link SqliteStorage} serializes all of them on one connection.
 */
export class SqliteAgentStorage implements AgentStorage {
  readonly threads: SqliteAgentThreadStore
  readonly runs: SqliteAgentRunStore
  readonly messages: SqliteAgentMessageStore

  private readonly connection: SqliteStoreConnection

  constructor(options: SqliteAgentStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }

    this.threads = new SqliteAgentThreadStore(this.connection.db)
    this.runs = new SqliteAgentRunStore(this.connection.db)
    this.messages = new SqliteAgentMessageStore(this.connection.db)
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}
