import type { AgentStorage, ExecutionStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import { PgAgentApprovalStore } from "./approvals"
import { PgAgentContextCheckpointStore } from "./checkpoints"
import { PgAgentMemoryStore } from "./memory"
import { PgAgentMessageStore } from "./messages"
import { PgAgentRunStore } from "./runs"
import { PgAgentApprovalModeStore } from "./settings"
import { PgAgentThreadStore } from "./threads"

export interface PgAgentStorageOptions {
  readonly sql: PgStoreClient
  readonly executions: ExecutionStorage
}

/**
 * PostgreSQL-backed agent persistence: thread, run, message, context-checkpoint, memory, approval
 * and approval-mode sub-stores sharing one connection. Cross-table writes run inside `runPgTransaction` with `SELECT ... FOR
 * UPDATE` row locks for single-flight and checkpoint compare-and-swap safety.
 */
export class PgAgentStorage implements AgentStorage {
  readonly threads: PgAgentThreadStore
  readonly runs: PgAgentRunStore
  readonly messages: PgAgentMessageStore
  readonly checkpoints: PgAgentContextCheckpointStore
  readonly memory: PgAgentMemoryStore
  readonly approvals: PgAgentApprovalStore
  readonly approvalModes: PgAgentApprovalModeStore

  constructor(options: PgAgentStorageOptions) {
    this.threads = new PgAgentThreadStore(options.sql)
    this.runs = new PgAgentRunStore(options.sql, options.executions)
    this.messages = new PgAgentMessageStore(options.sql)
    this.checkpoints = new PgAgentContextCheckpointStore(options.sql)
    this.memory = new PgAgentMemoryStore(options.sql)
    this.approvals = new PgAgentApprovalStore(options.sql)
    this.approvalModes = new PgAgentApprovalModeStore(options.sql)
  }
}
