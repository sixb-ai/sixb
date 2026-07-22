import { AsyncLocalStorage } from "node:async_hooks"
import { InMemoryActionRunStorage } from "../action-runs"
import { type AgentStorage, InMemoryAgentStorage } from "../agents"
import { type AuthStorage, InMemoryAuthStorage } from "../auth"
import { StorageTransactionError } from "../errors"
import { type FileUploadSessionStore, InMemoryFileUploadSessions } from "../file-upload-sessions"
import { InMemoryObjectStorage } from "../objects"
import type { OntologyStorage } from "../ontology"
import { InMemoryOntologyStorage } from "../ontology/in-memory"
import { InMemoryPipelineRunStorage, type PipelineRunStorage } from "../pipeline-runs"
import { InMemoryProjectionRunStorage } from "../projection-runs"
import { InMemoryRulesStorage, type RulesStorage } from "../rules"
import { InMemorySyncRunStorage, type SyncRunStorage } from "../sync-runs"
import { InMemoryTimeseriesStorage } from "../timeseries"
import { createTransactionStorageProxy, throwNestedStorageTransaction } from "../transaction"
import type { Storage, StorageTransactionOptions } from "../types"
import { InMemoryWebhookDeliveryStorage, type WebhookDeliveryStorage } from "../webhook-deliveries"
import { InMemoryWebhookRunStorage, type WebhookRunStorage } from "../webhook-runs"
import {
  InMemoryWorkflowInterventionStorage,
  type WorkflowInterventionStorage,
} from "../workflow-interventions"
import { InMemoryWorkflowRunStorage, type WorkflowRunStorage } from "../workflow-runs"
import {
  createAgentStorageFacade,
  createAuthStorageFacade,
  createWorkflowRunStorageFacade,
  FILE_UPLOAD_SESSION_ROOT_OPERATION_METHODS,
  OBJECT_ROOT_OPERATION_METHODS,
  PIPELINE_RUN_ROOT_OPERATION_METHODS,
  RULES_ROOT_OPERATION_METHODS,
  SYNC_RUN_ROOT_OPERATION_METHODS,
  TIMESERIES_ROOT_OPERATION_METHODS,
  WEBHOOK_DELIVERY_ROOT_OPERATION_METHODS,
  WEBHOOK_RUN_ROOT_OPERATION_METHODS,
  WORKFLOW_INTERVENTION_ROOT_OPERATION_METHODS,
} from "./manifests"
import { createRootOperationFacade } from "./root-operation-facade"

/**
 * In-memory {@link Storage} used for dev and tests.
 *
 * Every top-level storage call ("root operation") serializes against a single promise-chain lock
 * unless a transaction is already active, which is what gives {@link InMemoryStorage.transaction}
 * snapshot/rollback atomicity. Two complementary models attach that lock to the underlying stores:
 *
 * - **Façade-wrapped stores** (`objects`, `timeseries`, `auth`, `agents`, `syncRuns`,
 *   `pipelineRuns`, `workflowRuns`, `workflowInterventions`, `webhookDeliveries`, `webhookRuns`,
 *   `rules`, `fileUploadSessions`) are lock-unaware plain classes. They are wrapped externally by
 *   {@link createRootOperationFacade} using a static method manifest (see `./manifests.ts`). The
 *   façade uniformly re-acquires the lock for the listed methods while leaving the store ignorant
 *   of locking, and uses own-property descriptors (not a Proxy) so decoration and `spyOn` keep
 *   working.
 * - **Injected-runner stores** (`actionRuns`, `projectionRuns`, and `ontology`) receive
 *   `runRootOperation` in their constructor and call it inside their own method bodies. This gives
 *   them per-method control the façade cannot express: e.g. `projectionRuns` exposes
 *   `assertSourceMaterializationExecutionUnlocked`, a deliberately *unlocked* seam invoked from
 *   inside the ontology store's already-locked root operation to avoid re-entrantly acquiring the
 *   (non-reentrant) lock. The ontology store also fans `runRootOperation` out to its own child
 *   stores and needs extra injected seams (`getTransactionToken`,
 *   `assertSourceMaterializationExecution`), so it is inherently a runner consumer.
 *
 * The two models are intentionally not unified: converting the injected-runner stores to the
 * façade would require encoding their unlocked/re-entrant seams as manifest exclusions and lose
 * their per-method control, while converting the façade stores to the injected runner would spread
 * `runRootOperation` plumbing across a dozen otherwise lock-unaware stores. Either direction adds
 * code and risk for no behavioral gain.
 */
export class InMemoryStorage implements Storage {
  readonly objects: InMemoryObjectStorage
  readonly timeseries: InMemoryTimeseriesStorage
  readonly ontology: OntologyStorage
  private readonly objectStorage = new InMemoryObjectStorage()
  private readonly timeseriesStorage = new InMemoryTimeseriesStorage()
  private readonly ontologyStorage: InMemoryOntologyStorage
  private readonly authStorage = new InMemoryAuthStorage()
  private readonly agentStorage = new InMemoryAgentStorage()
  private readonly syncRunStorage = new InMemorySyncRunStorage()
  private readonly pipelineRunStorage = new InMemoryPipelineRunStorage()
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
    const runRootOperation = <T>(run: () => Promise<T> | T) => this.withStorageOperation(run)
    this.objects = createRootOperationFacade(
      this.objectStorage,
      OBJECT_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.timeseries = createRootOperationFacade(
      this.timeseriesStorage,
      TIMESERIES_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.auth = createAuthStorageFacade(this.authStorage, runRootOperation)
    this.agents = createAgentStorageFacade(this.agentStorage, runRootOperation)
    this.actionRuns = new InMemoryActionRunStorage({ runRootOperation })
    this.syncRuns = createRootOperationFacade(
      this.syncRunStorage,
      SYNC_RUN_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.pipelineRuns = createRootOperationFacade(
      this.pipelineRunStorage,
      PIPELINE_RUN_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.projectionRuns = new InMemoryProjectionRunStorage({ runRootOperation })
    this.workflowRuns = createWorkflowRunStorageFacade(this.workflowRunStorage, runRootOperation)
    this.workflowInterventions = createRootOperationFacade(
      this.workflowInterventionStorage,
      WORKFLOW_INTERVENTION_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.webhookDeliveries = createRootOperationFacade(
      this.webhookDeliveryStorage,
      WEBHOOK_DELIVERY_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.webhookRuns = createRootOperationFacade(
      this.webhookRunStorage,
      WEBHOOK_RUN_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.rules = createRootOperationFacade(
      this.rulesStorage,
      RULES_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.fileUploadSessions = createRootOperationFacade(
      this.fileUploadSessionStorage,
      FILE_UPLOAD_SESSION_ROOT_OPERATION_METHODS,
      runRootOperation
    )
    this.ontologyStorage = new InMemoryOntologyStorage(this.objectStorage, this.timeseriesStorage, {
      runRootOperation,
      getTransactionToken: () => this.getActiveTransactionToken(),
      assertSourceMaterializationExecution: (input) =>
        this.projectionRuns.assertSourceMaterializationExecutionUnlocked(input),
    })
    this.ontology = this.ontologyStorage
  }

  private readonly transactionScope = new AsyncLocalStorage<object>()
  private readonly activeTransactionTokens = new WeakSet<object>()
  private transactionTail: Promise<void> = Promise.resolve()

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
      const tx = createTransactionStorageProxy(this, () => active)
      const transactionToken = {}
      this.activeTransactionTokens.add(transactionToken)

      try {
        return await this.transactionScope.run(transactionToken, async () => run(tx))
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
        this.activeTransactionTokens.delete(transactionToken)
        active = false
      }
    })
  }

  private async withStorageOperation<T>(run: () => Promise<T> | T): Promise<T> {
    if (this.getActiveTransactionToken()) {
      return await run()
    }
    return this.withTransactionLock(async () => run())
  }

  private getActiveTransactionToken(): object | null {
    const token = this.transactionScope.getStore()
    return token && this.activeTransactionTokens.has(token) ? token : null
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

  private snapshot(): InMemoryStorageSnapshot {
    return {
      objects: this.objectStorage.snapshot(),
      timeseries: this.timeseriesStorage.snapshot(),
      ontology: this.ontologyStorage.snapshot(),
      auth: this.authStorage.snapshot(),
      agents: this.agentStorage.snapshot(),
      actionRuns: this.actionRuns.snapshot(),
      syncRuns: this.syncRunStorage.snapshot(),
      pipelineRuns: this.pipelineRunStorage.snapshot(),
      projectionRuns: this.projectionRuns.snapshot(),
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
    this.actionRuns.restore(snapshot.actionRuns)
    this.syncRunStorage.restore(snapshot.syncRuns)
    this.pipelineRunStorage.restore(snapshot.pipelineRuns)
    this.projectionRuns.restore(snapshot.projectionRuns)
    this.workflowRunStorage.restore(snapshot.workflowRuns)
    this.workflowInterventionStorage.restore(snapshot.workflowInterventions)
    this.webhookDeliveryStorage.restore(snapshot.webhookDeliveries)
    this.webhookRunStorage.restore(snapshot.webhookRuns)
    this.rulesStorage.restore(snapshot.rules)
    this.fileUploadSessionStorage.restore(snapshot.fileUploadSessions)
  }
}

interface InMemoryStorageSnapshot {
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
