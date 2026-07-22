import { describe, expect, test } from "bun:test"
import { commitExactObject, type OntologyContractStorage } from "./ontology-contract-fixture"

/** Stable logical failure points exercised by the provider-independent exact-plan fixture. */
export type MaterializationFailureBoundary =
  | "effective.object.upsert"
  | "outbox.insert"
  | "finalize"

export interface MaterializationFailureContractSuiteOptions<
  TStorage extends OntologyContractStorage = OntologyContractStorage,
  TSnapshot = unknown,
> {
  /** Factory that returns an isolated, transaction-capable storage facade for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional provider setup invoked after the storage facade is created. */
  readonly setup?: (storage: TStorage) => void | Promise<void>
  /** Optional provider cleanup invoked after every test, including failed tests. */
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** Captures every provider state that must participate in materialization rollback. */
  readonly captureState: (storage: TStorage) => TSnapshot | Promise<TSnapshot>
  /** Arms one logical write boundary to throw the supplied failure. */
  readonly injectFailure: (
    storage: TStorage,
    boundary: MaterializationFailureBoundary,
    failure: Error
  ) => void | Promise<void>
  /** Clears provider hooks after an injected attempt. */
  readonly clearFailure?: (storage: TStorage) => void | Promise<void>
  /** Providers may omit a boundary only when their test adapter cannot expose it. */
  readonly boundaries?: readonly MaterializationFailureBoundary[]
}

/**
 * Verifies that failures in the exact-plan write path leave no partial object,
 * commit, or outbox state. The suite is opt-in because production adapters do
 * not need to expose failure injection.
 */
export function runMaterializationFailureContractSuite<
  TStorage extends OntologyContractStorage,
  TSnapshot,
>(label: string, options: MaterializationFailureContractSuiteOptions<TStorage, TSnapshot>): void {
  const boundaries = options.boundaries ?? ["effective.object.upsert", "outbox.insert", "finalize"]

  describe(label, () => {
    for (const boundary of boundaries) {
      test(`rolls back the complete transaction when ${boundary} fails`, async () => {
        const storage = await options.createStorage()
        try {
          await options.setup?.(storage)
          const before = await options.captureState(storage)
          const failure = new Error(`contract injected ${boundary}`)
          await options.injectFailure(storage, boundary, failure)
          await expect(commitExactObject(storage, `failure-${boundary}`)).rejects.toThrow(
            failure.message
          )
          await options.clearFailure?.(storage)
          expect(await options.captureState(storage)).toEqual(before)
        } finally {
          await options.clearFailure?.(storage)
          await options.cleanup?.(storage)
        }
      })
    }
  })
}
