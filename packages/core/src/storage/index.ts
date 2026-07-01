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
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStore,
  AgentRunFinishReason,
  AgentRunLease,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStore,
  AgentRunUsage,
  AgentStorage,
  AgentStorageErrorCode,
  AgentThreadRecord,
  AgentThreadStatus,
  AgentThreadStore,
  AppendAgentMessageInput,
  CreateAgentThreadInput,
  FinishAgentRunInput,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ReclaimAgentRunInput,
  RenewAgentRunLeaseInput,
  ReserveAgentRunInput,
} from "./agents"
export {
  AGENT_RUN_FINISH_REASONS,
  AgentStorageError,
  coerceAgentRunFinishReason,
  InMemoryAgentStorage,
} from "./agents"
export type {
  AccessTokenRecord,
  AccessTokenSubjectType,
  AuthAccessTokenStore,
  AuthGroupMembershipStore,
  AuthInvitationStore,
  AuthMagicLinkStore,
  AuthOidcAuthorizationAttemptStore,
  AuthServiceAccountGroupMembershipStore,
  AuthServiceAccountStore,
  AuthSessionStore,
  AuthStorage,
  AuthStorageErrorCode,
  AuthUserIdentityStore,
  AuthUserStore,
  CompleteAuthSessionInput,
  CompleteMagicLinkSignInInput,
  CompleteOidcSignInInput,
  CompleteSignInResult,
  CreateAuthAccessTokenInput,
  CreateAuthMagicLinkInput,
  CreateAuthServiceAccountInput,
  CreateAuthSessionInput,
  CreateAuthUserInput,
  CreateOidcAuthorizationAttemptInput,
  CreateOrUpdateAuthInvitationInput,
  GroupMembershipRecord,
  GroupMembershipSource,
  InvitationRecord,
  InvitationStatus,
  ListAuthAccessTokensInput,
  ListAuthAccessTokensResult,
  ListAuthInvitationsInput,
  ListAuthInvitationsResult,
  ListAuthServiceAccountsInput,
  ListAuthServiceAccountsResult,
  ListAuthUsersInput,
  ListAuthUsersResult,
  MagicLinkRecord,
  OidcAuthorizationAttemptRecord,
  ReconcileAuthServiceAccountGroupMembershipsInput,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
  ServiceAccountStatus,
  SessionRecord,
  SuspendUserAndRevokeSessionsInput,
  UpdateAuthServiceAccountInput,
  UpdateAuthUserProfileInput,
  UpdateAuthUserStatusInput,
  UpsertAuthGroupMembershipInput,
  UpsertAuthServiceAccountGroupMembershipInput,
  UpsertAuthUserIdentityInput,
  UserIdentityRecord,
  UserRecord,
  UserStatus,
} from "./auth"
export { AuthStorageError, InMemoryAuthStorage } from "./auth"
export type {
  EditCommitLinkRef,
  EditCommitObjectRef,
  StorageTransactionErrorCode,
  StorageTransactionErrorOptions,
} from "./errors"
export {
  editCommitLinkCreateConflict,
  editCommitLinkUpdateMissing,
  editCommitObjectCreateConflict,
  editCommitObjectUpdateMissing,
  isStorageSerializationFailure,
  ObjectNotFoundError,
  ObjectStorageError,
  StorageTransactionError,
} from "./errors"
export type {
  CreateFileUploadSessionInput,
  FileUploadSession,
  FileUploadSessionErrorReason,
  FileUploadSessionStore,
  FileUploadStatus,
  FileUploadStrategy,
} from "./file-upload-sessions"
export {
  createFileUploadId,
  createUploadExpiresAt,
  DEFAULT_FILE_UPLOAD_SESSION_TTL_MS,
  DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS,
  FileUploadSessionError,
  InMemoryFileUploadSessions,
} from "./file-upload-sessions"
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
  ExpandedLinkValue,
  ExpandedObjectRow,
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
  ObjectRowLinks,
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
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionKind,
  ProjectionRunCounters,
  ProjectionRunObjectTypes,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  StartProjectionRunInput,
  UpdateProjectionRunInput,
} from "./projection-runs"
export {
  InMemoryProjectionRunStorage,
  PROJECTION_COUNTER_KEYS,
  ProjectionRunError,
  projectionRunObjectTypesVisible,
  zeroProjectionRunCounters,
} from "./projection-runs"
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
export type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesPoint,
  TimeseriesStorage,
} from "./timeseries"
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
import { InMemoryAgentStorage } from "./agents"
import { InMemoryAuthStorage } from "./auth"
import { StorageTransactionError } from "./errors"
import { InMemoryFileUploadSessions } from "./file-upload-sessions"
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
  readonly agents = new InMemoryAgentStorage()
  readonly actionRuns = new InMemoryActionRunStorage()
  readonly syncRuns = new InMemorySyncRunStorage()
  readonly pipelineRuns = new InMemoryPipelineRunStorage()
  readonly projectionRuns = new InMemoryProjectionRunStorage()
  readonly workflowRuns = new InMemoryWorkflowRunStorage()
  readonly workflowInterventions = new InMemoryWorkflowInterventionStorage()
  readonly webhookDeliveries = new InMemoryWebhookDeliveryStorage()
  readonly webhookRuns = new InMemoryWebhookRunStorage()
  readonly rules = new InMemoryRulesStorage()
  readonly fileUploadSessions = new InMemoryFileUploadSessions()

  private readonly transactionScope = new AsyncLocalStorage<boolean>()
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
      agents: this.agents.snapshot(),
      actionRuns: this.actionRuns.snapshot(),
      syncRuns: this.syncRuns.snapshot(),
      pipelineRuns: this.pipelineRuns.snapshot(),
      projectionRuns: this.projectionRuns.snapshot(),
      workflowRuns: this.workflowRuns.snapshot(),
      workflowInterventions: this.workflowInterventions.snapshot(),
      webhookDeliveries: this.webhookDeliveries.snapshot(),
      webhookRuns: this.webhookRuns.snapshot(),
      rules: this.rules.snapshot(),
      fileUploadSessions: this.fileUploadSessions.snapshot(),
    }
  }

  private restore(snapshot: InMemoryStorageSnapshot): void {
    this.objects.restore(snapshot.objects)
    this.timeseries.restore(snapshot.timeseries)
    this.auth.restore(snapshot.auth)
    this.agents.restore(snapshot.agents)
    this.actionRuns.restore(snapshot.actionRuns)
    this.syncRuns.restore(snapshot.syncRuns)
    this.pipelineRuns.restore(snapshot.pipelineRuns)
    this.projectionRuns.restore(snapshot.projectionRuns)
    this.workflowRuns.restore(snapshot.workflowRuns)
    this.workflowInterventions.restore(snapshot.workflowInterventions)
    this.webhookDeliveries.restore(snapshot.webhookDeliveries)
    this.webhookRuns.restore(snapshot.webhookRuns)
    this.rules.restore(snapshot.rules)
    this.fileUploadSessions.restore(snapshot.fileUploadSessions)
  }
}

interface InMemoryStorageSnapshot {
  readonly objects: ReturnType<InMemoryObjectStorage["snapshot"]>
  readonly timeseries: ReturnType<InMemoryTimeseriesStorage["snapshot"]>
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
