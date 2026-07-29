import { AsyncLocalStorage } from "node:async_hooks"
import { InMemoryActionRunStorage } from "../action-runs"
import { type AgentStorage, InMemoryAgentStorage } from "../agents"
import { type AuthStorage, InMemoryAuthStorage } from "../auth"
import { StorageTransactionError } from "../errors"
import { type FileUploadSessionStore, InMemoryFileUploadSessions } from "../file-upload-sessions"
import type { ObjectStorage } from "../objects"
import { InMemoryObjectStorage } from "../objects/in-memory"
import type { OntologyStorage } from "../ontology"
import { InMemoryOntologyStorage } from "../ontology/in-memory"
import { ProviderMaterializationTransactionLifecycle } from "../ontology/provider"
import {
  createAgentOperationScope,
  createAuthOperationScope,
  createOntologyOperationScope,
  createOperationScopedFacade,
  createStorageOperationScope,
  createWorkflowRunOperationScope,
} from "../operation-scope"
import { InMemoryPipelineRunStorage, type PipelineRunStorage } from "../pipeline-runs"
import { InMemoryProjectionRunStorage } from "../projection-runs"
import { InMemoryRulesStorage, type RulesStorage } from "../rules"
import { InMemorySyncRunStorage, type SyncRunStorage } from "../sync-runs"
import type { TimeseriesStorage } from "../timeseries"
import { InMemoryTimeseriesStorage } from "../timeseries/store"
import { createTransactionStorageProxy, throwNestedStorageTransaction } from "../transaction"
import type { Storage, StorageTransactionOptions } from "../types"
import { InMemoryWebhookDeliveryStorage, type WebhookDeliveryStorage } from "../webhook-deliveries"
import { InMemoryWebhookRunStorage, type WebhookRunStorage } from "../webhook-runs"
import {
  InMemoryWorkflowInterventionStorage,
  type WorkflowInterventionStorage,
} from "../workflow-interventions"
import { InMemoryWorkflowRunStorage, type WorkflowRunStorage } from "../workflow-runs"
import { registerInMemoryStorageTestingAdapter } from "./testing"

/**
 * In-memory {@link Storage} used for dev and tests.
 *
 * Every top-level storage call ("root operation") serializes against a single promise-chain lock
 * unless a transaction is already active, which is what gives {@link InMemoryStorage.transaction}
 * snapshot/rollback atomicity. The provider owns one operation scope and applies it to every async
 * root capability. Transaction calls reuse the already-active scope and therefore never reacquire
 * its non-reentrant lock.
 */
export class InMemoryStorage implements Storage {
  readonly objects: ObjectStorage
  readonly timeseries: TimeseriesStorage
  readonly ontology: OntologyStorage
  private readonly objectStorage = new InMemoryObjectStorage()
  private readonly timeseriesStorage = new InMemoryTimeseriesStorage()
  private readonly ontologyStorage: InMemoryOntologyStorage
  private readonly authStorage = new InMemoryAuthStorage()
  private readonly agentStorage = new InMemoryAgentStorage()
  private readonly actionRunStorage = new InMemoryActionRunStorage()
  private readonly syncRunStorage = new InMemorySyncRunStorage()
  private readonly pipelineRunStorage = new InMemoryPipelineRunStorage()
  private readonly projectionRunStorage = new InMemoryProjectionRunStorage()
  private readonly workflowRunStorage = new InMemoryWorkflowRunStorage()
  private readonly workflowInterventionStorage = new InMemoryWorkflowInterventionStorage()
  private readonly webhookDeliveryStorage = new InMemoryWebhookDeliveryStorage()
  private readonly webhookRunStorage = new InMemoryWebhookRunStorage()
  private readonly rulesStorage = new InMemoryRulesStorage()
  private readonly fileUploadSessionStorage = new InMemoryFileUploadSessions()
  readonly auth: AuthStorage
  readonly agents: AgentStorage
  readonly actionRuns: InMemoryActionRunStorage
  readonly syncRuns: SyncRunStorage
  readonly pipelineRuns: PipelineRunStorage
  readonly projectionRuns: InMemoryProjectionRunStorage
  readonly workflowRuns: WorkflowRunStorage
  readonly workflowInterventions: WorkflowInterventionStorage
  readonly webhookDeliveries: WebhookDeliveryStorage
  readonly webhookRuns: WebhookRunStorage
  readonly rules: RulesStorage
  readonly fileUploadSessions: FileUploadSessionStore

  constructor() {
    const scope = createStorageOperationScope(
      (run) => this.withStorageOperation(run),
      () => this.assertRootOperationAvailable()
    )
    this.objects = createOperationScopedFacade(this.objectStorage, scope)
    this.timeseries = createOperationScopedFacade(this.timeseriesStorage, scope)
    this.auth = createAuthOperationScope(this.authStorage, scope)
    this.agents = createAgentOperationScope(this.agentStorage, scope)
    this.actionRuns = createOperationScopedFacade(this.actionRunStorage, scope)
    this.syncRuns = createOperationScopedFacade(this.syncRunStorage, scope)
    this.pipelineRuns = createOperationScopedFacade(this.pipelineRunStorage, scope)
    this.projectionRuns = createOperationScopedFacade(this.projectionRunStorage, scope)
    this.workflowRuns = createWorkflowRunOperationScope(this.workflowRunStorage, scope)
    this.workflowInterventions = createOperationScopedFacade(
      this.workflowInterventionStorage,
      scope
    )
    this.webhookDeliveries = createOperationScopedFacade(this.webhookDeliveryStorage, scope)
    this.webhookRuns = createOperationScopedFacade(this.webhookRunStorage, scope)
    this.rules = createOperationScopedFacade(this.rulesStorage, scope)
    this.fileUploadSessions = createOperationScopedFacade(this.fileUploadSessionStorage, scope)
    this.ontologyStorage = new InMemoryOntologyStorage(this.objectStorage, this.timeseriesStorage, {
      runRootOperation: async (run) => run(),
      getTransactionToken: () => this.getActiveTransactionToken(),
      getMaterializationLifecycle: () => this.getActiveMaterializationLifecycle(),
      assertSourceMaterializationExecution: (input) =>
        this.projectionRunStorage.assertSourceMaterializationExecutionUnlocked(input),
    })
    this.ontology = createOntologyOperationScope(this.ontologyStorage, scope)
    this.ontologyStorage.registerTestingAlias(this.ontology)
    registerInMemoryStorageTestingAdapter(this, { snapshot: () => this.snapshot() })
  }

  private readonly transactionScope = new AsyncLocalStorage<object>()
  private readonly activeTransactionTokens = new WeakSet<object>()
  private readonly materializationLifecycles = new WeakMap<
    object,
    ProviderMaterializationTransactionLifecycle
  >()
  private transactionTail: Promise<void> = Promise.resolve()

  async ping(): Promise<void> {
    await this.withStorageOperation(() => undefined)
  }

  /**
   * Run `run` against a transactional view of this storage.
   *
   * Atomicity is achieved by snapshotting every store before the callback and restoring that
   * snapshot if it throws. The snapshot is a full structural clone of the in-memory dataset, so
   * its cost scales with total dataset size rather than changeset size. That is acceptable for the
   * dev/test role of {@link InMemoryStorage} but is the reason it is not intended for large
   * datasets under heavy transactional load — the SQL providers use real database transactions.
   *
   * The `isolation` option is intentionally ignored: the promise-chain lock serializes
   * transactions one at a time, which is at least as strong as `serializable`.
   */
  async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    _options: StorageTransactionOptions = {}
  ): Promise<T> {
    const inheritedTransactionToken = this.transactionScope.getStore()
    if (inheritedTransactionToken && this.activeTransactionTokens.has(inheritedTransactionToken)) {
      throwNestedStorageTransaction()
    }

    return this.withTransactionLock(async () => {
      const snapshot = this.snapshot()
      let active = true
      const tx = createTransactionStorageProxy(this.createTransactionStorage(), () => active)
      const transactionToken = {}
      const materializationLifecycle = new ProviderMaterializationTransactionLifecycle()
      this.activeTransactionTokens.add(transactionToken)
      this.materializationLifecycles.set(transactionToken, materializationLifecycle)

      try {
        const result = await this.transactionScope.run(transactionToken, async () => run(tx))
        materializationLifecycle.assertCommittable()
        return result
      } catch (error) {
        // A failed rollback leaves the store in an unknown state. Surface that explicitly instead
        // of letting the restore error silently replace (mask) the original transaction error.
        try {
          this.restore(snapshot)
        } catch (restoreError) {
          throw new StorageTransactionError(
            `[Sixb] In-memory storage failed to roll back after a transaction error; state may be inconsistent. Original transaction error: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: restoreError }
          )
        }
        throw error
      } finally {
        this.ontologyStorage.completeTransaction(transactionToken)
        materializationLifecycle.deactivate()
        this.activeTransactionTokens.delete(transactionToken)
        active = false
      }
    })
  }

  private async withStorageOperation<T>(run: () => Promise<T> | T): Promise<T> {
    this.assertRootOperationAvailable()
    return this.withTransactionLock(async () => run())
  }

  private assertRootOperationAvailable(): void {
    if (!this.getActiveTransactionToken()) return
    throw new StorageTransactionError(
      "[Sixb] Root storage cannot be used inside a transaction callback; use the provided tx storage."
    )
  }

  private getActiveTransactionToken(): object | null {
    const token = this.transactionScope.getStore()
    return token && this.activeTransactionTokens.has(token) ? token : null
  }

  private getActiveMaterializationLifecycle(): ProviderMaterializationTransactionLifecycle | null {
    const token = this.getActiveTransactionToken()
    return token ? (this.materializationLifecycles.get(token) ?? null) : null
  }

  private async withTransactionLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.transactionTail
    let release!: () => void
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }

  private createTransactionStorage(): Storage {
    return {
      objects: this.objectStorage,
      timeseries: this.timeseriesStorage,
      ontology: this.ontologyStorage,
      auth: this.authStorage,
      agents: this.agentStorage,
      actionRuns: this.actionRunStorage,
      syncRuns: this.syncRunStorage,
      pipelineRuns: this.pipelineRunStorage,
      projectionRuns: this.projectionRunStorage,
      workflowRuns: this.workflowRunStorage,
      workflowInterventions: this.workflowInterventionStorage,
      webhookDeliveries: this.webhookDeliveryStorage,
      webhookRuns: this.webhookRunStorage,
      rules: this.rulesStorage,
      fileUploadSessions: this.fileUploadSessionStorage,
      ping: async () => undefined,
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }

  private snapshot(): InMemoryStorageSnapshot {
    return {
      objects: this.objectStorage.snapshot(),
      timeseries: this.timeseriesStorage.snapshot(),
      ontology: this.ontologyStorage.snapshot(),
      auth: this.authStorage.snapshot(),
      agents: this.agentStorage.snapshot(),
      actionRuns: this.actionRunStorage.snapshot(),
      syncRuns: this.syncRunStorage.snapshot(),
      pipelineRuns: this.pipelineRunStorage.snapshot(),
      projectionRuns: this.projectionRunStorage.snapshot(),
      workflowRuns: this.workflowRunStorage.snapshot(),
      workflowInterventions: this.workflowInterventionStorage.snapshot(),
      webhookDeliveries: this.webhookDeliveryStorage.snapshot(),
      webhookRuns: this.webhookRunStorage.snapshot(),
      rules: this.rulesStorage.snapshot(),
      fileUploadSessions: this.fileUploadSessionStorage.snapshot(),
    }
  }

  private restore(snapshot: InMemoryStorageSnapshot): void {
    this.objectStorage.restore(snapshot.objects)
    this.timeseriesStorage.restore(snapshot.timeseries)
    this.ontologyStorage.restore(snapshot.ontology)
    this.authStorage.restore(snapshot.auth)
    this.agentStorage.restore(snapshot.agents)
    this.actionRunStorage.restore(snapshot.actionRuns)
    this.syncRunStorage.restore(snapshot.syncRuns)
    this.pipelineRunStorage.restore(snapshot.pipelineRuns)
    this.projectionRunStorage.restore(snapshot.projectionRuns)
    this.workflowRunStorage.restore(snapshot.workflowRuns)
    this.workflowInterventionStorage.restore(snapshot.workflowInterventions)
    this.webhookDeliveryStorage.restore(snapshot.webhookDeliveries)
    this.webhookRunStorage.restore(snapshot.webhookRuns)
    this.rulesStorage.restore(snapshot.rules)
    this.fileUploadSessionStorage.restore(snapshot.fileUploadSessions)
  }
}

export interface InMemoryStorageSnapshot {
  readonly objects: ReturnType<InMemoryObjectStorage["snapshot"]>
  readonly timeseries: ReturnType<InMemoryTimeseriesStorage["snapshot"]>
  readonly ontology: ReturnType<InMemoryOntologyStorage["snapshot"]>
  readonly auth: ReturnType<InMemoryAuthStorage["snapshot"]>
  readonly agents: ReturnType<InMemoryAgentStorage["snapshot"]>
  readonly actionRuns: ReturnType<InMemoryActionRunStorage["snapshot"]>
  readonly syncRuns: ReturnType<InMemorySyncRunStorage["snapshot"]>
  readonly pipelineRuns: ReturnType<InMemoryPipelineRunStorage["snapshot"]>
  readonly projectionRuns: ReturnType<InMemoryProjectionRunStorage["snapshot"]>
  readonly workflowRuns: ReturnType<InMemoryWorkflowRunStorage["snapshot"]>
  readonly workflowInterventions: ReturnType<InMemoryWorkflowInterventionStorage["snapshot"]>
  readonly webhookDeliveries: ReturnType<InMemoryWebhookDeliveryStorage["snapshot"]>
  readonly webhookRuns: ReturnType<InMemoryWebhookRunStorage["snapshot"]>
  readonly rules: ReturnType<InMemoryRulesStorage["snapshot"]>
  readonly fileUploadSessions: ReturnType<InMemoryFileUploadSessions["snapshot"]>
}
