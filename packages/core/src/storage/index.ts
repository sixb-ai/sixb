export type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStatus,
  ActionRunStorage,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  StartActionRunInput,
} from "./action-runs"
export { ActionRunError, InMemoryActionRunStorage } from "./action-runs"
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
export type { ObjectLinkRow, ObjectRow, ObjectStorage } from "./objects"
export { InMemoryObjectStorage } from "./objects"
export type {
  FinishPipelineRunInput,
  FinishPipelineStepRunInput,
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
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
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
  readonly webhookDeliveries = new InMemoryWebhookDeliveryStorage()
  readonly rules = new InMemoryRulesStorage()
}
