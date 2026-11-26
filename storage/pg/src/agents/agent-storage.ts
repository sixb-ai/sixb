import type { AgentStorage, ExecutionStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import { PgAgentApprovalStore } from "./approvals"
import { PgAgentContextCheckpointStore } from "./checkpoints"
import { PgAgentComputerSessionStore } from "./computers"
import { PgAgentInboxStore } from "./inbox"
import { PgAgentMemoryStore } from "./memory"
import { PgAgentMessageStore } from "./messages"
import { PgAgentThreadReadStore } from "./reads"
import { PgAgentRunStore } from "./runs"
import { PgAgentApprovalModeStore } from "./settings"
import { PgAgentThreadStore } from "./threads"
import { PgAgentTokenRateStore } from "./token-rates"
import { PgAgentTurnVectorStore } from "./turn-vectors"

export interface PgAgentStorageOptions {
  readonly sql: PgStoreClient
  readonly executions: ExecutionStorage
}

/**
 * PostgreSQL-backed agent persistence: thread, run, message, context-checkpoint, memory, approval,
 * approval-mode, computer-session and token-rate sub-stores sharing one connection. Cross-table writes run
 * inside `runPgTransaction` with `SELECT ... FOR UPDATE` row locks for single-flight and checkpoint
 * compare-and-swap safety.
 */
export class PgAgentStorage implements AgentStorage {
  readonly threads: PgAgentThreadStore
  readonly reads: PgAgentThreadReadStore
  readonly runs: PgAgentRunStore
  readonly messages: PgAgentMessageStore
  readonly checkpoints: PgAgentContextCheckpointStore
  readonly memory: PgAgentMemoryStore
  readonly approvals: PgAgentApprovalStore
  readonly approvalModes: PgAgentApprovalModeStore
  readonly computers: PgAgentComputerSessionStore
  readonly tokenRates: PgAgentTokenRateStore
  readonly inbox: PgAgentInboxStore
  readonly turnVectors: PgAgentTurnVectorStore

  constructor(options: PgAgentStorageOptions) {
    this.threads = new PgAgentThreadStore(options.sql)
    this.reads = new PgAgentThreadReadStore(options.sql)
    this.runs = new PgAgentRunStore(options.sql, options.executions)
    this.messages = new PgAgentMessageStore(options.sql)
    this.checkpoints = new PgAgentContextCheckpointStore(options.sql)
    this.memory = new PgAgentMemoryStore(options.sql)
    this.approvals = new PgAgentApprovalStore(options.sql)
    this.approvalModes = new PgAgentApprovalModeStore(options.sql)
    this.computers = new PgAgentComputerSessionStore(options.sql)
    this.tokenRates = new PgAgentTokenRateStore(options.sql)
    this.inbox = new PgAgentInboxStore(options.sql)
    this.turnVectors = new PgAgentTurnVectorStore(options.sql)
  }
}
