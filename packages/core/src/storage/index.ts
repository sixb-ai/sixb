export type {
  ActionRunCommitDiff,
  ActionRunCommitRecord,
  ActionRunCommitSourceRow,
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunLinkDiffSourceRow,
  ActionRunLinkEditDiff,
  ActionRunObjectDiffPropertySourceRow,
  ActionRunObjectDiffSourceRow,
  ActionRunObjectEditDiff,
  ActionRunObjectRef,
  ActionRunParams,
  ActionRunPhase,
  ActionRunPhaseRecord,
  ActionRunPhaseStatus,
  ActionRunRecord,
  ActionRunStatus,
  ActionRunStorage,
  ActionRunWritebackRecord,
  EnterActionRunPhaseInput,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  RecordActionCommitInput,
  RecordActionEffectsInput,
  RecordActionWritebackInput,
  StartActionRunInput,
} from "./action-runs"
export {
  ActionRunError,
  actionRunCommitDiffsEqual,
  actionRunParamsEqual,
  actionRunPhaseRecordsEqual,
  actionSubjectsEqual,
  buildActionRunCommitRecords,
  canRequeueActionRunAfterEnqueueFailure,
  finishActionRunPhase,
  InMemoryActionRunStorage,
  isTerminalActionRun,
  normalizeActionRunCommitDiff,
} from "./action-runs"
export type {
  AuthGroupMembershipStore,
  AuthInvitationStore,
  AuthMagicLinkStore,
  AuthOidcAuthorizationAttemptStore,
  AuthSessionStore,
  AuthStorage,
  AuthStorageErrorCode,
  AuthUserIdentityStore,
  AuthUserStore,
  CompleteAuthSessionInput,
  CompleteMagicLinkSignInInput,
  CompleteOidcSignInInput,
  CompleteSignInResult,
  CreateAuthMagicLinkInput,
  CreateAuthSessionInput,
  CreateAuthUserInput,
  CreateOidcAuthorizationAttemptInput,
  CreateOrUpdateAuthInvitationInput,
  GroupMembershipRecord,
  GroupMembershipSource,
  InvitationRecord,
  InvitationStatus,
  ListAuthInvitationsInput,
  ListAuthInvitationsResult,
  ListAuthUsersInput,
  ListAuthUsersResult,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  SessionRecord,
  SuspendUserAndRevokeSessionsInput,
  UpdateAuthUserProfileInput,
  UpdateAuthUserStatusInput,
  UpsertAuthGroupMembershipInput,
  UpsertAuthUserIdentityInput,
  UserIdentityRecord,
  UserRecord,
  UserStatus,
} from "./auth"
export { AuthStorageError, InMemoryAuthStorage } from "./auth"
export type { CommitEditBatchInput, EditCommitResult, EditStorage } from "./edits"
export { EditStorageError, InMemoryEditStorage } from "./edits"
export { ObjectNotFoundError, StorageTransactionError } from "./errors"
export type {
  DefineMigrationsOptions,
  MigrationCapableStorage,
  MigrationHistoryStore,
  MigrationPlan,
  MigrationRecord,
  MigrationReport,
  MigrationSet,
  MigrationStep,
  MigrationStepInfo,
  MigrationStepOptions,
  StorageMigrationResult,
  StorageMigrator,
} from "./migrations"
export {
  defineMigrations,
  isMigrationCapableStorage,
  migrateStorage,
  planMigrationSet,
  runMigrationSet,
  step,
} from "./migrations"
export type {
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  LinkDirection,
  ObjectFacetBucket,
  ObjectFacetRequest,
  ObjectFacetResult,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectQueryCapabilityMap,
  ObjectRow,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "./objects"
export { InMemoryObjectStorage } from "./objects"
export type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListLatestPipelineRunsInput,
  ListLatestPipelineRunsResult,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunFailure,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineRunStorage,
  PipelineStepRunRecord,
  StartPipelineRunInput,
  StartPipelineStepRunInput,
} from "./pipeline-runs"
export { InMemoryPipelineRunStorage, PipelineRunError } from "./pipeline-runs"
export type {
  FinishProjectionRunInput,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionKind,
  ProjectionRunCounters,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  StartProjectionRunInput,
  UpdateProjectionRunInput,
} from "./projection-runs"
export { InMemoryProjectionRunStorage, ProjectionRunError } from "./projection-runs"
export type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleStateRecord,
  RulesStorage,
} from "./rules"
export { InMemoryRulesStorage } from "./rules"
export type {
  FinishSyncRunInput,
  ListLatestSyncRunsInput,
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  StartSyncRunInput,
  SyncRunFailure,
  SyncRunRecord,
  SyncRunStatus,
  SyncRunStorage,
} from "./sync-runs"
export { InMemorySyncRunStorage, SyncRunError } from "./sync-runs"
export type { TimeseriesPoint, TimeseriesStorage } from "./timeseries"
export { InMemoryTimeseriesStorage } from "./timeseries"
export {
  assertTransactionActive,
  createTransactionStorageProxy,
  throwNestedStorageTransaction,
} from "./transaction"
export type { Storage, StorageTransactionOptions } from "./types"
export type {
  WebhookDeliveryClaimRecord,
  WebhookDeliveryClaimResult,
  WebhookDeliveryKey,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDeliveryStorage,
} from "./webhook-deliveries"
export { InMemoryWebhookDeliveryStorage } from "./webhook-deliveries"
export type {
  FinishWebhookRunInput,
  FinishWebhookRunStatus,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStatus,
  WebhookRunStorage,
} from "./webhook-runs"
export { InMemoryWebhookRunStorage, WebhookRunError } from "./webhook-runs"
export type {
  CancelWorkflowInterventionInput,
  CreateWorkflowInterventionInput,
  ExpireWorkflowInterventionInput,
  ListWorkflowInterventionsInput,
  ListWorkflowInterventionsResult,
  SubmitWorkflowInterventionInput,
  WorkflowInterventionActor,
  WorkflowInterventionRecord,
  WorkflowInterventionStatus,
  WorkflowInterventionStorage,
} from "./workflow-interventions"
export {
  InMemoryWorkflowInterventionStorage,
  WorkflowInterventionError,
} from "./workflow-interventions"
export type {
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowIOSnapshot,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStatus,
  WorkflowNodeRunStorage,
  WorkflowNodeRunType,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStorage,
} from "./workflow-runs"
export {
  InMemoryWorkflowNodeRunStorage,
  InMemoryWorkflowRunStorage,
  WorkflowRunError,
} from "./workflow-runs"

import { AsyncLocalStorage } from "node:async_hooks"
import { InMemoryActionRunStorage } from "./action-runs"
import { InMemoryAuthStorage } from "./auth"
import { InMemoryEditStorage } from "./edits"
import { InMemoryObjectStorage } from "./objects"
import { InMemoryPipelineRunStorage } from "./pipeline-runs"
import { InMemoryProjectionRunStorage } from "./projection-runs"
import { InMemoryRulesStorage } from "./rules"
import { InMemorySyncRunStorage } from "./sync-runs"
import { InMemoryTimeseriesStorage } from "./timeseries"
import { createTransactionStorageProxy, throwNestedStorageTransaction } from "./transaction"
import type { Storage, StorageTransactionOptions } from "./types"
import { InMemoryWebhookDeliveryStorage } from "./webhook-deliveries"
import { InMemoryWebhookRunStorage } from "./webhook-runs"
import { InMemoryWorkflowInterventionStorage } from "./workflow-interventions"
import { InMemoryWorkflowRunStorage } from "./workflow-runs"

export class InMemoryStorage implements Storage {
  readonly objects = new InMemoryObjectStorage()
  readonly timeseries = new InMemoryTimeseriesStorage()
  readonly auth = new InMemoryAuthStorage()
  readonly actionRuns = new InMemoryActionRunStorage()
  readonly edits = new InMemoryEditStorage(this.objects, this.actionRuns)
  readonly syncRuns = new InMemorySyncRunStorage()
  readonly pipelineRuns = new InMemoryPipelineRunStorage()
  readonly projectionRuns = new InMemoryProjectionRunStorage()
  readonly workflowRuns = new InMemoryWorkflowRunStorage()
  readonly workflowInterventions = new InMemoryWorkflowInterventionStorage()
  readonly webhookDeliveries = new InMemoryWebhookDeliveryStorage()
  readonly webhookRuns = new InMemoryWebhookRunStorage()
  readonly rules = new InMemoryRulesStorage()

  private readonly transactionScope = new AsyncLocalStorage<boolean>()
  private transactionTail: Promise<void> = Promise.resolve()

  async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    _options: StorageTransactionOptions = {}
  ): Promise<T> {
    if (this.transactionScope.getStore()) {
      throwNestedStorageTransaction()
    }

    return this.withTransactionLock(async () => {
      const snapshot = this.snapshot()
      let active = true
      const tx = createTransactionStorageProxy(this, () => active)

      try {
        return await this.transactionScope.run(true, async () => run(tx))
      } catch (error) {
        this.restore(snapshot)
        throw error
      } finally {
        active = false
      }
    })
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
      objects: this.objects.snapshot(),
      timeseries: this.timeseries.snapshot(),
      auth: this.auth.snapshot(),
      actionRuns: this.actionRuns.snapshot(),
      syncRuns: this.syncRuns.snapshot(),
      pipelineRuns: this.pipelineRuns.snapshot(),
      projectionRuns: this.projectionRuns.snapshot(),
      workflowRuns: this.workflowRuns.snapshot(),
      workflowInterventions: this.workflowInterventions.snapshot(),
      webhookDeliveries: this.webhookDeliveries.snapshot(),
      webhookRuns: this.webhookRuns.snapshot(),
      rules: this.rules.snapshot(),
    }
  }

  private restore(snapshot: InMemoryStorageSnapshot): void {
    this.objects.restore(snapshot.objects)
    this.timeseries.restore(snapshot.timeseries)
    this.auth.restore(snapshot.auth)
    this.actionRuns.restore(snapshot.actionRuns)
    this.syncRuns.restore(snapshot.syncRuns)
    this.pipelineRuns.restore(snapshot.pipelineRuns)
    this.projectionRuns.restore(snapshot.projectionRuns)
    this.workflowRuns.restore(snapshot.workflowRuns)
    this.workflowInterventions.restore(snapshot.workflowInterventions)
    this.webhookDeliveries.restore(snapshot.webhookDeliveries)
    this.webhookRuns.restore(snapshot.webhookRuns)
    this.rules.restore(snapshot.rules)
  }
}

interface InMemoryStorageSnapshot {
  readonly objects: ReturnType<InMemoryObjectStorage["snapshot"]>
  readonly timeseries: ReturnType<InMemoryTimeseriesStorage["snapshot"]>
  readonly auth: ReturnType<InMemoryAuthStorage["snapshot"]>
  readonly actionRuns: ReturnType<InMemoryActionRunStorage["snapshot"]>
  readonly syncRuns: ReturnType<InMemorySyncRunStorage["snapshot"]>
  readonly pipelineRuns: ReturnType<InMemoryPipelineRunStorage["snapshot"]>
  readonly projectionRuns: ReturnType<InMemoryProjectionRunStorage["snapshot"]>
  readonly workflowRuns: ReturnType<InMemoryWorkflowRunStorage["snapshot"]>
  readonly workflowInterventions: ReturnType<InMemoryWorkflowInterventionStorage["snapshot"]>
  readonly webhookDeliveries: ReturnType<InMemoryWebhookDeliveryStorage["snapshot"]>
  readonly webhookRuns: ReturnType<InMemoryWebhookRunStorage["snapshot"]>
  readonly rules: ReturnType<InMemoryRulesStorage["snapshot"]>
}
