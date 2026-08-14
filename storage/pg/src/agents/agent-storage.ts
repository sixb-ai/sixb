import type { AgentStorage, ExecutionStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import { PgAgentMessageStore } from "./messages"
import { PgAgentRunStore } from "./runs"
import { PgAgentThreadStore } from "./threads"

export interface PgAgentStorageOptions {
  readonly sql: PgStoreClient
  readonly executions: ExecutionStorage
}

/**
 * PostgreSQL-backed agent persistence: thread / run / message sub-stores sharing one connection.
 * Cross-table writes (reserve + finish touch the thread anchor, append bumps thread stats) run
 * inside `runPgTransaction` with `SELECT ... FOR UPDATE` row locks for single-flight safety.
 */
export class PgAgentStorage implements AgentStorage {
  readonly threads: PgAgentThreadStore
  readonly runs: PgAgentRunStore
  readonly messages: PgAgentMessageStore

  constructor(options: PgAgentStorageOptions) {
    this.threads = new PgAgentThreadStore(options.sql)
    this.runs = new PgAgentRunStore(options.sql, options.executions)
    this.messages = new PgAgentMessageStore(options.sql)
  }
}
