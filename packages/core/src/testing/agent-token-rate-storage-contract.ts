import { describe, expect, test } from "bun:test"
import {
  type AgentStorage,
  AgentStorageError,
  type AgentTokenRateRecord,
  type AgentTokenRateStore,
} from "../storage/agents"
import { AGENT_TOKEN_RATE_SAMPLES } from "../storage/agents/types"

export interface AgentTokenRateStorageContractStorage {
  readonly agents: Pick<AgentStorage, "tokenRates">
}

export interface AgentTokenRateStorageContractSuiteOptions<
  TStorage extends AgentTokenRateStorageContractStorage = AgentTokenRateStorageContractStorage,
> {
  /** Returns a fresh, empty storage bundle for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** How many measurements the storage holds, every model and project included. */
  readonly countStored: (storage: TStorage) => Promise<number>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "token-rate-contract"
const model = { providerId: "anthropic", modelId: "claude-haiku-5.5" }
const t0 = new Date("2026-11-01T10:00:00.000Z")
const minute = 60 * 1000

/** Provider-neutral persistence contract for the bytes per token each model measured. */
export function runAgentTokenRateStorageContractSuite<
  TStorage extends AgentTokenRateStorageContractStorage,
>(label: string, options: AgentTokenRateStorageContractSuiteOptions<TStorage>): void {
  const withRates = async (
    run: (rates: AgentTokenRateStore, storage: TStorage) => Promise<void>
  ): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage.agents.tokenRates, storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("lists nothing for a model no run measured", async () => {
      await withRates(async (rates) => {
        expect(await rates.listLatest({ projectId, ...model })).toEqual([])
      })
    })

    test("lists a model's measurements newest first", async () => {
      await withRates(async (rates) => {
        await rates.record(sample(1, { bytes: 24_000, tokens: 10_000 }))
        await rates.record(sample(3, { bytes: 26_000, tokens: 10_000 }))
        await rates.record(sample(2, { bytes: 25_000, tokens: 10_000 }))

        expect(await rates.listLatest({ projectId, ...model })).toEqual([
          sample(3, { bytes: 26_000, tokens: 10_000 }),
          sample(2, { bytes: 25_000, tokens: 10_000 }),
          sample(1, { bytes: 24_000, tokens: 10_000 }),
        ])
      })
    })

    test("keeps a model's newest measurements and drops the rest", async () => {
      await withRates(async (rates, storage) => {
        // One past the limit, recorded out of order: the oldest goes, whenever it was recorded.
        for (let index = AGENT_TOKEN_RATE_SAMPLES; index >= 0; index--) {
          await rates.record(sample(index))
        }

        const kept = await rates.listLatest({ projectId, ...model })
        expect(kept.map((record) => record.runId)).toEqual(
          Array.from({ length: AGENT_TOKEN_RATE_SAMPLES }, (_, index) =>
            runId(AGENT_TOKEN_RATE_SAMPLES - index)
          )
        )
        expect(await options.countStored(storage)).toBe(AGENT_TOKEN_RATE_SAMPLES)

        // Older than every kept one: dropped as it is recorded.
        await rates.record(sample(-1))
        expect(await options.countStored(storage)).toBe(AGENT_TOKEN_RATE_SAMPLES)
        expect(await rates.listLatest({ projectId, ...model })).toEqual(kept)
      })
    })

    test("keeps one measurement per run, its latest", async () => {
      await withRates(async (rates, storage) => {
        await rates.record(sample(1, { bytes: 24_000 }))
        await rates.record(sample(1, { bytes: 30_000, measuredAt: at(5) }))

        expect(await rates.listLatest({ projectId, ...model })).toEqual([
          sample(1, { bytes: 30_000, measuredAt: at(5) }),
        ])
        expect(await options.countStored(storage)).toBe(1)
      })
    })

    test("keeps each model of each project apart", async () => {
      await withRates(async (rates, storage) => {
        const others = [
          { providerId: "vercel-ai-gateway", modelId: model.modelId },
          { providerId: model.providerId, modelId: "claude-sonnet-5" },
        ]
        // A full window for each other model and the other project, all newer than the model's.
        for (let index = 0; index < AGENT_TOKEN_RATE_SAMPLES; index++) {
          for (const other of others) {
            await rates.record({
              ...sample(index + 10),
              ...other,
              runId: `${other.modelId}-${index}`,
            })
          }
          await rates.record({ ...sample(index + 10), projectId: "token-rate-contract-other" })
        }
        await rates.record(sample(1))

        expect(await rates.listLatest({ projectId, ...model })).toEqual([sample(1)])
        expect(await rates.listLatest({ projectId, ...others[0]! })).toHaveLength(
          AGENT_TOKEN_RATE_SAMPLES
        )
        expect(await options.countStored(storage)).toBe(3 * AGENT_TOKEN_RATE_SAMPLES + 1)
      })
    })

    test("rejects a measurement without tokens, bytes or a model", async () => {
      await withRates(async (rates, storage) => {
        for (const input of [
          sample(1, { tokens: 0 }),
          sample(1, { bytes: -5 }),
          sample(1, { bytes: 1.5 }),
          { ...sample(1), modelId: " " },
        ]) {
          const rejected = await rates.record(input).catch((error: unknown) => error)
          expect(rejected).toBeInstanceOf(AgentStorageError)
          expect((rejected as AgentStorageError).code).toBe("invalid_input")
        }
        expect(await options.countStored(storage)).toBe(0)
      })
    })
  })
}

function runId(index: number): string {
  return `run_${String(index + 100).padStart(4, "0")}`
}

function at(index: number): Date {
  return new Date(t0.getTime() + index * minute)
}

/** The measurement of run `index`, taken `index` minutes after t0. */
function sample(
  index: number,
  overrides: Partial<AgentTokenRateRecord> = {}
): AgentTokenRateRecord {
  return {
    projectId,
    ...model,
    runId: runId(index),
    bytes: 24_000,
    tokens: 10_000,
    measuredAt: at(index),
    ...overrides,
  }
}
