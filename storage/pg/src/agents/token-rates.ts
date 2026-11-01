import {
  AGENT_TOKEN_RATE_SAMPLES,
  assertAgentTokenRateRecord,
} from "@sixb/core/internal/agent-run-storage-provider"
import type { AgentTokenRateRecord, AgentTokenRateStore } from "@sixb/core/storage"
import { type PgStoreClient, runPgTransaction } from "../transactions"

interface TokenRateRow {
  readonly project_id: string
  readonly run_id: string
  readonly provider_id: string
  readonly model_id: string
  readonly bytes: number
  readonly tokens: number
  readonly measured_at: Date
}

export class PgAgentTokenRateStore implements AgentTokenRateStore {
  constructor(private readonly sql: PgStoreClient) {}

  async record(input: AgentTokenRateRecord): Promise<void> {
    assertAgentTokenRateRecord(input, "SixbPg")

    await runPgTransaction(this.sql, async (tx) => {
      await tx`
        INSERT INTO agent_token_rates (
          project_id, run_id, provider_id, model_id, bytes, tokens, measured_at
        ) VALUES (
          ${input.projectId}, ${input.runId}, ${input.providerId}, ${input.modelId},
          ${input.bytes}, ${input.tokens}, ${input.measuredAt}
        )
        ON CONFLICT (project_id, run_id) DO UPDATE SET
          provider_id = EXCLUDED.provider_id, model_id = EXCLUDED.model_id,
          bytes = EXCLUDED.bytes, tokens = EXCLUDED.tokens, measured_at = EXCLUDED.measured_at
      `

      // A statement of its own: one sharing the insert's snapshot would not see the new row.
      await tx`
        DELETE FROM agent_token_rates
        WHERE project_id = ${input.projectId} AND provider_id = ${input.providerId}
          AND model_id = ${input.modelId}
          AND run_id NOT IN (
            SELECT run_id FROM agent_token_rates
            WHERE project_id = ${input.projectId} AND provider_id = ${input.providerId}
              AND model_id = ${input.modelId}
            ORDER BY measured_at DESC, run_id DESC
            LIMIT ${AGENT_TOKEN_RATE_SAMPLES}
          )
      `
    })
  }

  async listLatest(input: {
    readonly projectId: string
    readonly providerId: string
    readonly modelId: string
  }): Promise<readonly AgentTokenRateRecord[]> {
    const rows = await this.sql<TokenRateRow[]>`
      SELECT project_id, run_id, provider_id, model_id, bytes, tokens, measured_at
      FROM agent_token_rates
      WHERE project_id = ${input.projectId} AND provider_id = ${input.providerId}
        AND model_id = ${input.modelId}
      ORDER BY measured_at DESC, run_id DESC
      LIMIT ${AGENT_TOKEN_RATE_SAMPLES}
    `
    return rows.map((row) => ({
      projectId: row.project_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      runId: row.run_id,
      bytes: row.bytes,
      tokens: row.tokens,
      measuredAt: row.measured_at,
    }))
  }
}
