import type { ActionRunStorage } from "./action-runs"
import type { AgentStorage } from "./agents"
import type { AiUsageStorage } from "./ai-usage"
import type { AuthStorage } from "./auth"
import type { ExecutionStorage } from "./executions"
import type { FileUploadSessionStore } from "./file-upload-sessions"
import type { ObjectStorage } from "./objects/types"
import type { OntologyStorage } from "./ontology"
import type { PipelineRunStorage } from "./pipeline-runs"
import type { ProjectionRunStorage } from "./projection-runs"
import type { RulesStorage } from "./rules"
import type { SyncRunStorage } from "./sync-runs"
import type { TimeseriesStorage } from "./timeseries/types"
import type { WebhookDeliveryStorage } from "./webhook-deliveries"
import type { WebhookRunStorage } from "./webhook-runs"
import type { WorkflowInterventionStorage } from "./workflow-interventions"
import type { WorkflowRunStorage } from "./workflow-runs"

export type {
  PinnedDatasetVersion,
  ProjectionExecution,
  ProjectionMaterializationIdentity,
} from "../materialization/model"
export type {
  ActionRunFailure,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunStatus,
  ActionRunStorage,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  LockActionMaterializationRunInput,
  QueueActionRunInput,
  StartActionRunInput,
} from "./action-runs"
export { ActionRunError } from "./action-runs"
export type {
  AgentMessageRecord,
  AgentRunExecution,
  AgentRunFailureCode,
  AgentRunRecord,
  AgentStorage,
  AgentThreadRecord,
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
export { AGENT_RUN_FAILURE_CODES, AgentStorageError } from "./agents"
export type {
  AiModelCallUsage,
  AiModelCallUsageInput,
  AiModelCallUsageRecord,
  AiUsageExecutionSummary,
  AiUsageReportingStatus,
  AiUsageStorage,
  AiUsageStorageErrorCode,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
  SummarizeAiUsageExecutionInput,
  SummarizeAiUsageExecutionsInput,
} from "./ai-usage"
export {
  AiUsageStorageError,
  aggregateAiModelCallUsage,
  assertAiUsageExecutionId,
  normalizeAiModelCallRecord,
  normalizeAiModelCallUsage,
} from "./ai-usage"
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
  ReconcileAuthServiceAccountGroupMembershipsInput,
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
export { AuthStorageError } from "./auth"
export type { StorageTransactionErrorCode, StorageTransactionErrorOptions } from "./errors"
export {
  isStorageSerializationFailure,
  ObjectStorageError,
  StorageTransactionError,
} from "./errors"
export type {
  CreateFileUploadSessionInput,
  FileUploadSession,
  FileUploadSessionStore,
  FileUploadStatus,
  FileUploadStrategy,
} from "./file-upload-sessions"
export { FileUploadSessionError } from "./file-upload-sessions"
export type {
  LinkDirection,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectQueryCapabilityMap,
  ObjectRow,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "./objects/types"
export type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunFailureCode,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineRunStorage,
  PipelineStepRunRecord,
  StartPipelineRunInput,
  StartPipelineStepRunInput,
} from "./pipeline-runs"
export { PipelineRunError } from "./pipeline-runs"
export type {
  AdvanceProjectionTelemetryCheckpointInput,
  FinishProjectionRunInput,
  LinkProjectionRunRecord,
  LinkProjectionTarget,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  LockProjectionRunForMaterializationInput,
  ObjectProjectionRunRecord,
  ObjectProjectionTarget,
  ProjectionKind,
  ProjectionRunClaim,
  ProjectionRunFailureCode,
  ProjectionRunProgress,
  ProjectionRunRecord,
  ProjectionRunStatus,
  ProjectionRunStorage,
  ProjectionTarget,
  ProjectionTelemetryCheckpoint,
  StartOrReclaimProjectionRunInput,
  TelemetryProjectionRunRecord,
  UpdateProjectionRunInput,
} from "./projection-runs"
export { PROJECTION_RUN_FAILURE_CODES, ProjectionRunError } from "./projection-runs"
export type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleStateRecord,
  RulesStorage,
} from "./rules"
export type {
  FinishSyncRunInput,
  ListSyncRunsInput,
  ListSyncRunsResult,
  StartSyncRunInput,
  SyncRunFailureCode,
  SyncRunMode,
  SyncRunRecord,
  SyncRunStatus,
  SyncRunStorage,
} from "./sync-runs"
export { SyncRunError } from "./sync-runs"
export type {
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesPoint,
  TimeseriesStorage,
} from "./timeseries/types"
export type {
  WebhookDeliveryClaimRecord,
  WebhookDeliveryClaimResult,
  WebhookDeliveryKey,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDeliveryStorage,
} from "./webhook-deliveries"
export type {
  FinishWebhookRunInput,
  FinishWebhookRunStatus,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  StartWebhookRunInput,
  WebhookRunFailureCode,
  WebhookRunRecord,
  WebhookRunStatus,
  WebhookRunStorage,
} from "./webhook-runs"
export { WEBHOOK_RUN_FAILURE_CODES, WebhookRunError } from "./webhook-runs"
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
export { WorkflowInterventionError } from "./workflow-interventions"
export type {
  CancelWorkflowAgentNodeRunInput,
  ConfirmWorkflowAgentNodeRunExecutionOwnershipInput,
  ConfirmWorkflowRunExecutionOwnershipInput,
  CreateWorkflowAgentNodeRunInput,
  FinishWorkflowAgentNodeRunInput,
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListWorkflowAgentNodeRunsInput,
  ListWorkflowAgentNodeRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ReclaimWorkflowAgentNodeRunInput,
  ReclaimWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowAgentNodeRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowAgentNodeRunExecution,
  WorkflowAgentNodeRunRecord,
  WorkflowAgentNodeRunStatus,
  WorkflowAgentNodeRunStorage,
  WorkflowIOSnapshot,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStatus,
  WorkflowNodeRunStorage,
  WorkflowNodeRunType,
  WorkflowRunExecution,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStorage,
} from "./workflow-runs"
export { WORKFLOW_RUN_FAILURE_CODES, WorkflowRunError } from "./workflow-runs"

export interface StorageTransactionOptions {
  readonly isolation?: "default" | "serializable"
}

export interface Storage {
  objects: ObjectStorage
  timeseries: TimeseriesStorage
  ontology: OntologyStorage
  executions: ExecutionStorage
  auth?: AuthStorage
  agents?: AgentStorage
  aiUsage?: AiUsageStorage
  actionRuns?: ActionRunStorage
  syncRuns?: SyncRunStorage
  pipelineRuns?: PipelineRunStorage
  projectionRuns?: ProjectionRunStorage
  workflowRuns?: WorkflowRunStorage
  workflowInterventions?: WorkflowInterventionStorage
  webhookDeliveries?: WebhookDeliveryStorage
  webhookRuns?: WebhookRunStorage
  rules?: RulesStorage
  fileUploadSessions?: FileUploadSessionStore

  /** Lightweight reachability probe. It must not open a write transaction or run migrations. */
  ping(): Promise<void>

  /**
   * Runs every capability exposed on `tx` on one atomic transaction/connection. If the callback
   * throws, writes performed through any of those capabilities must roll back together.
   */
  transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    options?: StorageTransactionOptions
  ): Promise<T>

  /**
   * Release external resources (connections, pools, file handles).
   *
   * Optional: a provider that owns none omits it. Hosts must close storage
   * *after* whatever claims from it — the CLI drains the outbox and closes the
   * broker first, or the final publication loses the rows it was reading.
   */
  close?(): void | Promise<void>
}
