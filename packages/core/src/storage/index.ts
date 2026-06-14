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
  QueueActionRunInput,
  StartActionRunInput,
} from "./action-runs"
export {
  ActionRunError,
  actionRunParamsEqual,
  actionSubjectsEqual,
  canRequeueActionRunAfterEnqueueFailure,
  InMemoryActionRunStorage,
  isTerminalActionRun,
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
export { ObjectNotFoundError } from "./errors"
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
export type { Storage } from "./types"
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

import { InMemoryActionRunStorage } from "./action-runs"
import { InMemoryAuthStorage } from "./auth"
import { InMemoryObjectStorage } from "./objects"
import { InMemoryPipelineRunStorage } from "./pipeline-runs"
import { InMemoryProjectionRunStorage } from "./projection-runs"
import { InMemoryRulesStorage } from "./rules"
import { InMemorySyncRunStorage } from "./sync-runs"
import { InMemoryTimeseriesStorage } from "./timeseries"
import type { Storage } from "./types"
import { InMemoryWebhookDeliveryStorage } from "./webhook-deliveries"
import { InMemoryWebhookRunStorage } from "./webhook-runs"
import { InMemoryWorkflowInterventionStorage } from "./workflow-interventions"
import { InMemoryWorkflowRunStorage } from "./workflow-runs"

export class InMemoryStorage implements Storage {
  readonly objects = new InMemoryObjectStorage()
  readonly timeseries = new InMemoryTimeseriesStorage()
  readonly auth = new InMemoryAuthStorage()
  readonly actionRuns = new InMemoryActionRunStorage()
  readonly syncRuns = new InMemorySyncRunStorage()
  readonly pipelineRuns = new InMemoryPipelineRunStorage()
  readonly projectionRuns = new InMemoryProjectionRunStorage()
  readonly workflowRuns = new InMemoryWorkflowRunStorage()
  readonly workflowInterventions = new InMemoryWorkflowInterventionStorage()
  readonly webhookDeliveries = new InMemoryWebhookDeliveryStorage()
  readonly webhookRuns = new InMemoryWebhookRunStorage()
  readonly rules = new InMemoryRulesStorage()
}
