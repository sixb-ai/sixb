export type {
  ActionMaterializationRunStorage,
  ActionRunCommitDiff,
  ActionRunCommitRecord,
  ActionRunCommitSourceRow,
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunLinkDiffSourceRow,
  ActionRunLinkEditDiff,
  ActionRunMaterializationBookkeeping,
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
  AssertActionMaterializationRunInput,
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
  isActionMaterializationRunStorage,
  isTerminalActionRun,
  normalizeActionRunCommitDiff,
} from "./action-runs"
export type {
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStore,
  AgentRunDiagnostic,
  AgentRunDiagnosticCode,
  AgentRunDiagnosticSeverity,
  AgentRunExecution,
  AgentRunFinishReason,
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
  ConfirmAgentRunExecutionOwnershipInput,
  CreateAgentRunInput,
  CreateAgentThreadInput,
  FinishAgentRunInput,
  FinishQueuedAgentRunInput,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ReclaimAgentRunInput,
  StartAgentRunInput,
} from "./agents"
export {
  AGENT_RUN_DIAGNOSTIC_CODES,
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
  AbandonSourceMaterializationCandidateInput,
  AbandonSourceMaterializationInput,
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  AssertSourceMaterializationExecution,
  AssertSourceMaterializationExecutionInput,
  BeginSourceMaterializationInput,
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  CompleteOntologyOutboxLeaseInput,
  EditOntologyCommitIntent,
  ExactEffectiveLinkDelete,
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectDelete,
  ExactEffectiveObjectWrite,
  ExactEffectiveWrites,
  ExactLinkOverrideDelete,
  ExactLinkOverrideWrite,
  ExactObjectOverrideDelete,
  ExactObjectOverrideWrite,
  ExactOverrideWrites,
  ExactTimeseriesPointWrite,
  ExactTimeseriesWrites,
  ExpectedSourceRevision,
  ExpectedTimeseriesPointRevision,
  FinalizeMaterializationInput,
  GetActiveOntologySourceInput,
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  MarkSourceMaterializationReadyInput,
  MaterializationApplyPhase,
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationCasState,
  MaterializationClassificationWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationIncidentObjectWorkRecord,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectExistence,
  MaterializationObjectExistenceWorkRecord,
  MaterializationObjectState,
  MaterializationPlanChunk,
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  MaterializationPlanWorkItem,
  MaterializationPlanWorkRecord,
  MaterializationRunBookkeeping,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationStateRequestChunk,
  MaterializationWorkEntityKind,
  MaterializationWorkPage,
  MaterializationWorkRecord,
  OntologyCommitRecord,
  OntologyCommitStorage,
  OntologyCommitWrite,
  OntologyMaterializationEvent,
  OntologyMaterializationEventDraft,
  OntologyMaterializationStorage,
  OntologyOutboxRecord,
  OntologyOutboxStorage,
  OntologyOutboxWrite,
  OntologySourceMaterializationStatus,
  OntologySourceRecord,
  OntologySourceStorage,
  OntologyStorage,
  ProjectionOntologyCommitIntent,
  PurgePublishedOntologyOutboxInput,
  ReadMaterializationObjectExistenceInput,
  ReclaimSourceMaterializationInput,
  RescheduleOntologyOutboxLeaseInput,
  SourceActivationWrite,
  SourceMaterializationExecution,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  SourceReplacementStatePage,
  StageMaterializationWorkInput,
  StageSourceAssertion,
  StageSourceRowsInput,
  StageSourceRowsResult,
  StoredLinkOverride,
  StoredObjectOverride,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
  StoredTelemetryPoint,
  StreamMaterializationStateInput,
  StreamMaterializationWorkInput,
  StreamSourceReplacementStateInput,
  TelemetryOntologyCommitIntent,
} from "./ontology"
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
  AssertProjectionMaterializationExecutionInput,
  FinishProjectionMaterializationInput,
  FinishProjectionRunInput,
  ListLatestProjectionRunsInput,
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionKind,
  ProjectionMaterializationProtocol,
  ProjectionMaterializationRunRecord,
  ProjectionMaterializationRunStorage,
  ProjectionReplacementMaterializationCounts,
  ProjectionRunCounters,
  ProjectionRunDatasetVersion,
  ProjectionRunMaterializationBookkeeping,
  ProjectionRunMaterializationCounters,
  ProjectionRunMaterializationIdentity,
  ProjectionRunMaterializationReplay,
  ProjectionRunObjectTypes,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  ProjectionTelemetryMaterializationCounts,
  StartOrReclaimProjectionMaterializationInput,
  StartProjectionRunInput,
  UpdateProjectionMaterializationInput,
  UpdateProjectionRunInput,
} from "./projection-runs"
export {
  InMemoryProjectionRunStorage,
  isProjectionMaterializationRunStorage,
  PROJECTION_COUNTER_KEYS,
  ProjectionRunError,
  projectionRunObjectTypesVisible,
  zeroProjectionRunCounters,
  zeroProjectionRunMaterializationCounters,
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
import {
  type AgentMessageStore,
  type AgentRunStore,
  type AgentStorage,
  type AgentThreadStore,
  InMemoryAgentStorage,
} from "./agents"
import {
  type AuthAccessTokenStore,
  type AuthGroupMembershipStore,
  type AuthInvitationStore,
  type AuthMagicLinkStore,
  type AuthOidcAuthorizationAttemptStore,
  type AuthServiceAccountGroupMembershipStore,
  type AuthServiceAccountStore,
  type AuthSessionStore,
  type AuthStorage,
  type AuthUserIdentityStore,
  type AuthUserStore,
  InMemoryAuthStorage,
} from "./auth"
import { StorageTransactionError } from "./errors"
import { type FileUploadSessionStore, InMemoryFileUploadSessions } from "./file-upload-sessions"
import { InMemoryObjectStorage, type ObjectStorage } from "./objects"
import type { OntologyStorage } from "./ontology"
import { InMemoryOntologyStorage } from "./ontology/in-memory"
import { InMemoryPipelineRunStorage, type PipelineRunStorage } from "./pipeline-runs"
import { InMemoryProjectionRunStorage } from "./projection-runs"
import { InMemoryRulesStorage, type RulesStorage } from "./rules"
import { InMemorySyncRunStorage, type SyncRunStorage } from "./sync-runs"
import { InMemoryTimeseriesStorage, type TimeseriesStorage } from "./timeseries"
import { createTransactionStorageProxy, throwNestedStorageTransaction } from "./transaction"
import type { Storage, StorageTransactionOptions } from "./types"
import { InMemoryWebhookDeliveryStorage, type WebhookDeliveryStorage } from "./webhook-deliveries"
import { InMemoryWebhookRunStorage, type WebhookRunStorage } from "./webhook-runs"
import {
  InMemoryWorkflowInterventionStorage,
  type WorkflowInterventionStorage,
} from "./workflow-interventions"
import {
  InMemoryWorkflowRunStorage,
  type WorkflowNodeRunStorage,
  type WorkflowRunStorage,
} from "./workflow-runs"

type AsyncMethodKeys<T> = Extract<
  {
    [K in keyof T]-?: NonNullable<T[K]> extends (...args: infer _Args) => Promise<unknown>
      ? K
      : never
  }[keyof T],
  string
>

function rootOperationMethods<T extends object>(
  methods: Readonly<Record<AsyncMethodKeys<T>, true>>
): readonly AsyncMethodKeys<T>[] {
  return Object.keys(methods) as AsyncMethodKeys<T>[]
}

const OBJECT_ROOT_OPERATION_METHODS = rootOperationMethods<ObjectStorage>({
  queryObjects: true,
  countObjects: true,
  existsObjects: true,
  facetObjects: true,
  applyObjectUpsert: true,
  applyObjectUpsertBatch: true,
  applyTelemetryAppended: true,
  applyTelemetryAppendedBatch: true,
  applyLinkUpsert: true,
  applyLinkUpsertBatch: true,
  applyLinkDelete: true,
  applyEditCommitPlan: true,
  getByPrimaryId: true,
  listLinks: true,
  getByPrimaryIdBatch: true,
  listLinksBatch: true,
  listIncidentLinksBatch: true,
  list: true,
})

const TIMESERIES_ROOT_OPERATION_METHODS = rootOperationMethods<TimeseriesStorage>({
  applyTelemetryAppended: true,
  applyTelemetryAppendedBatch: true,
  getHistory: true,
  getHistoryBatch: true,
  getLatest: true,
})

const AUTH_ROOT_OPERATION_METHODS = rootOperationMethods<AuthStorage>({
  completeMagicLinkSignIn: true,
  completeOidcSignIn: true,
  suspendUserAndRevokeSessions: true,
})

const AUTH_USER_ROOT_OPERATION_METHODS = rootOperationMethods<AuthUserStore>({
  create: true,
  getById: true,
  getByEmail: true,
  updateProfile: true,
  updateStatus: true,
  list: true,
})

const AUTH_IDENTITY_ROOT_OPERATION_METHODS = rootOperationMethods<AuthUserIdentityStore>({
  upsert: true,
  getBySubject: true,
  listForUser: true,
})

const AUTH_SERVICE_ACCOUNT_ROOT_OPERATION_METHODS = rootOperationMethods<AuthServiceAccountStore>({
  create: true,
  getById: true,
  update: true,
  list: true,
})

const AUTH_SERVICE_ACCOUNT_GROUP_MEMBERSHIP_ROOT_OPERATION_METHODS =
  rootOperationMethods<AuthServiceAccountGroupMembershipStore>({
    upsert: true,
    reconcileForServiceAccount: true,
    listForServiceAccount: true,
    listForGroup: true,
  })

const AUTH_SESSION_ROOT_OPERATION_METHODS = rootOperationMethods<AuthSessionStore>({
  create: true,
  getById: true,
  getActiveByUserId: true,
  listActiveByUserId: true,
  findValidByTokenHash: true,
  renewIfValid: true,
  revoke: true,
  revokeActiveForUser: true,
  touch: true,
})

const AUTH_ACCESS_TOKEN_ROOT_OPERATION_METHODS = rootOperationMethods<AuthAccessTokenStore>({
  create: true,
  getById: true,
  list: true,
  findValidByTokenHash: true,
  revoke: true,
  touch: true,
})

const AUTH_INVITATION_ROOT_OPERATION_METHODS = rootOperationMethods<AuthInvitationStore>({
  createOrUpdateActive: true,
  getById: true,
  getActiveByEmail: true,
  list: true,
  accept: true,
  revoke: true,
})

const AUTH_GROUP_MEMBERSHIP_ROOT_OPERATION_METHODS = rootOperationMethods<AuthGroupMembershipStore>(
  {
    upsert: true,
    remove: true,
    listForUser: true,
    listForGroup: true,
  }
)

const AUTH_MAGIC_LINK_ROOT_OPERATION_METHODS = rootOperationMethods<AuthMagicLinkStore>({
  create: true,
  getById: true,
  getActiveByEmail: true,
  consume: true,
  revokeActiveForEmail: true,
})

const AUTH_OIDC_ATTEMPT_ROOT_OPERATION_METHODS =
  rootOperationMethods<AuthOidcAuthorizationAttemptStore>({
    create: true,
    getById: true,
    consume: true,
  })

const AGENT_THREAD_ROOT_OPERATION_METHODS = rootOperationMethods<AgentThreadStore>({
  create: true,
  getById: true,
  list: true,
})

const AGENT_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<AgentRunStore>({
  create: true,
  start: true,
  finishQueued: true,
  reclaim: true,
  confirmExecutionOwnership: true,
  finish: true,
  getById: true,
  getByIds: true,
  list: true,
})

const AGENT_MESSAGE_ROOT_OPERATION_METHODS = rootOperationMethods<AgentMessageStore>({
  append: true,
  getById: true,
  list: true,
})

const AGENT_ROOT_OPERATION_METHODS = rootOperationMethods<AgentStorage>({})

const SYNC_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<SyncRunStorage>({
  start: true,
  finish: true,
  getById: true,
  list: true,
  listLatestBySyncIds: true,
})

const PIPELINE_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<PipelineRunStorage>({
  start: true,
  finish: true,
  startStep: true,
  finishStep: true,
  getById: true,
  list: true,
  listLatestByPipelineIds: true,
  listSteps: true,
})

const WORKFLOW_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<WorkflowRunStorage>({
  queue: true,
  start: true,
  wait: true,
  resume: true,
  finish: true,
  getById: true,
  list: true,
  listLatestByWorkflowIds: true,
})

const WORKFLOW_NODE_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<WorkflowNodeRunStorage>({
  start: true,
  wait: true,
  finish: true,
  getById: true,
  list: true,
})

const WORKFLOW_INTERVENTION_ROOT_OPERATION_METHODS =
  rootOperationMethods<WorkflowInterventionStorage>({
    create: true,
    submit: true,
    cancel: true,
    expire: true,
    getById: true,
    list: true,
  })

const WEBHOOK_DELIVERY_ROOT_OPERATION_METHODS = rootOperationMethods<WebhookDeliveryStorage>({
  claim: true,
  complete: true,
  fail: true,
})

const WEBHOOK_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<WebhookRunStorage>({
  start: true,
  finish: true,
  getById: true,
  list: true,
})

const RULES_ROOT_OPERATION_METHODS = rootOperationMethods<RulesStorage>({
  getActive: true,
  listActive: true,
  applyTriggered: true,
  applyResolved: true,
})

const FILE_UPLOAD_SESSION_ROOT_OPERATION_METHODS = rootOperationMethods<FileUploadSessionStore>({
  create: true,
  getForPrincipal: true,
  markUploaded: true,
  addSignedPart: true,
  complete: true,
  abort: true,
  cleanupExpired: true,
})

function createRootOperationFacade<T extends object>(
  target: T,
  operationMethods: readonly PropertyKey[],
  runRootOperation: <TResult>(run: () => Promise<TResult> | TResult) => Promise<TResult>,
  propertyOverrides: Partial<T> = {}
): T {
  const operations = new Set<PropertyKey>(operationMethods)
  const wrappers = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>()

  return new Proxy(target, {
    get(current, property) {
      if (Object.hasOwn(propertyOverrides, property)) {
        return Reflect.get(propertyOverrides, property, propertyOverrides)
      }

      const value = Reflect.get(current, property, current)
      if (typeof value !== "function") return value

      if (!operations.has(property)) {
        return value.bind(current)
      }

      const existing = wrappers.get(property)
      if (existing) return existing

      // Lock only the public boundary. The method runs with the raw store as `this`, so batch
      // methods can call their single-item methods without trying to acquire the root lock again.
      const wrapper = (...args: unknown[]) =>
        runRootOperation(() => Reflect.apply(value, current, args))
      wrappers.set(property, wrapper)
      return wrapper
    },
  })
}

type RootOperationRunner = <TResult>(run: () => Promise<TResult> | TResult) => Promise<TResult>

function createAuthStorageFacade(
  target: InMemoryAuthStorage,
  runRootOperation: RootOperationRunner
): AuthStorage {
  return createRootOperationFacade(target, AUTH_ROOT_OPERATION_METHODS, runRootOperation, {
    users: createRootOperationFacade(
      target.users,
      AUTH_USER_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    identities: createRootOperationFacade(
      target.identities,
      AUTH_IDENTITY_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    serviceAccounts: createRootOperationFacade(
      target.serviceAccounts,
      AUTH_SERVICE_ACCOUNT_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    serviceAccountGroupMemberships: createRootOperationFacade(
      target.serviceAccountGroupMemberships,
      AUTH_SERVICE_ACCOUNT_GROUP_MEMBERSHIP_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    sessions: createRootOperationFacade(
      target.sessions,
      AUTH_SESSION_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    accessTokens: createRootOperationFacade(
      target.accessTokens,
      AUTH_ACCESS_TOKEN_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    invitations: createRootOperationFacade(
      target.invitations,
      AUTH_INVITATION_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    groupMemberships: createRootOperationFacade(
      target.groupMemberships,
      AUTH_GROUP_MEMBERSHIP_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    magicLinks: createRootOperationFacade(
      target.magicLinks,
      AUTH_MAGIC_LINK_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    oidcAuthorizationAttempts: createRootOperationFacade(
      target.oidcAuthorizationAttempts,
      AUTH_OIDC_ATTEMPT_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
  })
}

function createAgentStorageFacade(
  target: InMemoryAgentStorage,
  runRootOperation: RootOperationRunner
): AgentStorage {
  return createRootOperationFacade(target, AGENT_ROOT_OPERATION_METHODS, runRootOperation, {
    threads: createRootOperationFacade(
      target.threads,
      AGENT_THREAD_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    runs: createRootOperationFacade(
      target.runs,
      AGENT_RUN_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
    messages: createRootOperationFacade(
      target.messages,
      AGENT_MESSAGE_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
  })
}

function createWorkflowRunStorageFacade(
  target: InMemoryWorkflowRunStorage,
  runRootOperation: RootOperationRunner
): WorkflowRunStorage {
  return createRootOperationFacade(target, WORKFLOW_RUN_ROOT_OPERATION_METHODS, runRootOperation, {
    nodes: createRootOperationFacade(
      target.nodes,
      WORKFLOW_NODE_RUN_ROOT_OPERATION_METHODS,
      runRootOperation
    ),
  })
}

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
      applyBookkeeping: async (projectId, bookkeeping) => {
        if (bookkeeping.kind === "action") {
          await this.actionRuns.recordMaterializationCommit(projectId, bookkeeping)
        } else {
          await this.projectionRuns.recordMaterializationCommit(projectId, bookkeeping)
        }
      },
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
