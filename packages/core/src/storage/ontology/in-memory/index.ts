import type { InMemoryObjectStorage } from "../../objects"
import type { InMemoryTimeseriesStorage } from "../../timeseries"
import type { OntologyStorage } from ".."
import type { AssertSourceMaterializationExecution } from "../sources"
import { InMemoryOntologyCommitStorage } from "./commits"
import { InMemoryOntologyMaterializationStorage } from "./materializations"
import { InMemoryOntologyOutboxStorage } from "./outbox"
import {
  cloneOntologyState,
  createInMemoryOntologyState,
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  restoreOntologyState,
} from "./shared-state"
import { InMemoryOntologySourceStorage } from "./sources"
import { registerInMemoryOntologyStorageTestingAdapter } from "./testing"

export type InMemoryOntologyStorageSnapshot = InMemoryOntologyState

interface InMemoryOntologyStorageOptions {
  readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  readonly getTransactionToken: () => object | null
  readonly assertSourceMaterializationExecution: AssertSourceMaterializationExecution
}

export class InMemoryOntologyStorage implements OntologyStorage {
  private readonly state = createInMemoryOntologyState()
  readonly commits: InMemoryOntologyCommitStorage
  readonly sources: InMemoryOntologySourceStorage
  readonly materializations: InMemoryOntologyMaterializationStorage
  readonly outbox: InMemoryOntologyOutboxStorage
  private testHooks: InMemoryOntologyStorageTestHooks = {}

  constructor(
    objects: InMemoryObjectStorage,
    timeseries: InMemoryTimeseriesStorage,
    options: InMemoryOntologyStorageOptions
  ) {
    this.commits = new InMemoryOntologyCommitStorage(this.state, options.runRootOperation)
    this.sources = new InMemoryOntologySourceStorage(
      this.state,
      options.runRootOperation,
      options.assertSourceMaterializationExecution
    )
    this.outbox = new InMemoryOntologyOutboxStorage(this.state, options.runRootOperation)
    this.materializations = new InMemoryOntologyMaterializationStorage(
      this.state,
      objects,
      timeseries,
      options.getTransactionToken,
      {
        beforeRead: (boundary) => this.testHooks.beforeRead?.(boundary),
        beforeWrite: (boundary, ordinal) => this.testHooks.beforeWrite?.(boundary, ordinal),
        observeBuffer: (boundary, rows) => this.testHooks.observeBuffer?.(boundary, rows),
        observeWork: (records) => this.testHooks.observeWork?.(records),
      }
    )
    registerInMemoryOntologyStorageTestingAdapter(this, {
      setTestHooks: (hooks) => this.setTestHooks(hooks),
      snapshot: () => this.snapshot(),
    })
  }

  /** @internal Test-only failure injection; not part of OntologyStorage. */
  setTestHooks(hooks: InMemoryOntologyStorageTestHooks): void {
    this.testHooks = hooks
  }

  snapshot(): InMemoryOntologyStorageSnapshot {
    return cloneOntologyState(this.state)
  }

  restore(snapshot: InMemoryOntologyStorageSnapshot): void {
    restoreOntologyState(this.state, snapshot)
  }

  completeTransaction(transactionToken: object): void {
    this.materializations.deactivateTransaction(transactionToken)
  }
}

export type { InMemoryOntologyStorageTestHooks } from "./shared-state"
