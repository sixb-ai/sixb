import type { Database } from "bun:sqlite"
import {
  AGENT_TOKEN_RATE_SAMPLES,
  assertAgentTokenRateRecord,
} from "@sixb/core/internal/agent-run-storage-provider"
import type { AgentTokenRateRecord, AgentTokenRateStore } from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"

interface TokenRateRow {
  readonly project_id: string
  readonly run_id: string
  readonly provider_id: string
  readonly model_id: string
  readonly bytes: number
  readonly tokens: number
  readonly measured_at: string
}

export class SqliteAgentTokenRateStore implements AgentTokenRateStore {
  constructor(private readonly db: Database) {}

  async record(input: AgentTokenRateRecord): Promise<void> {
    assertAgentTokenRateRecord(input, "SixbSqlite")

    runImmediateTransaction(this.db, () => {
      this.db
        .query(
          `INSERT INTO agent_token_rates (
             project_id, run_id, provider_id, model_id, bytes, tokens, measured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, run_id) DO UPDATE SET
             provider_id = excluded.provider_id, model_id = excluded.model_id,
             bytes = excluded.bytes, tokens = excluded.tokens, measured_at = excluded.measured_at`
        )
        .run(
          input.projectId,
          input.runId,
          input.providerId,
          input.modelId,
          input.bytes,
          input.tokens,
          input.measuredAt.toISOString()
        )

      this.db
        .query(
          `DELETE FROM agent_token_rates
           WHERE project_id = ?1 AND provider_id = ?2 AND model_id = ?3
             AND run_id NOT IN (
               SELECT run_id FROM agent_token_rates
               WHERE project_id = ?1 AND provider_id = ?2 AND model_id = ?3
               ORDER BY measured_at DESC, run_id DESC
               LIMIT ?4
             )`
        )
        .run(input.projectId, input.providerId, input.modelId, AGENT_TOKEN_RATE_SAMPLES)
    })
  }

  async listLatest(input: {
    readonly projectId: string
    readonly providerId: string
    readonly modelId: string
  }): Promise<readonly AgentTokenRateRecord[]> {
    const rows = this.db
      .query(
        `SELECT project_id, run_id, provider_id, model_id, bytes, tokens, measured_at
         FROM agent_token_rates
         WHERE project_id = ? AND provider_id = ? AND model_id = ?
         ORDER BY measured_at DESC, run_id DESC
         LIMIT ?`
      )
      .all(
        input.projectId,
        input.providerId,
        input.modelId,
        AGENT_TOKEN_RATE_SAMPLES
      ) as TokenRateRow[]

    return rows.map((row) => ({
      projectId: row.project_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      runId: row.run_id,
      bytes: row.bytes,
      tokens: row.tokens,
      measuredAt: new Date(row.measured_at),
    }))
  }
}
