import type { ActionRunStorage } from "./action-runs"
import type { AuthStorage } from "./auth"
import type { ObjectStorage } from "./objects/types"
import type { PipelineRunStorage } from "./pipeline-runs"
import type { ProjectionRunStorage } from "./projection-runs"
import type { RulesStorage } from "./rules"
import type { SyncRunStorage } from "./sync-runs"
import type { TimeseriesStorage } from "./timeseries/types"
import type { WebhookDeliveryStorage } from "./webhook-deliveries"
import type { WebhookRunStorage } from "./webhook-runs"
import type { WorkflowRunStorage } from "./workflow-runs"

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
export { ActionRunError } from "./action-runs"
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
export { AuthStorageError } from "./auth"
export type { ObjectLinkRow, ObjectRow, ObjectStorage } from "./objects/types"
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
export { PipelineRunError } from "./pipeline-runs"
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
export { ProjectionRunError } from "./projection-runs"
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
  SyncRunFailure,
  SyncRunRecord,
  SyncRunStatus,
  SyncRunStorage,
} from "./sync-runs"
export { SyncRunError } from "./sync-runs"
export type { TimeseriesPoint, TimeseriesStorage } from "./timeseries/types"
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
  WebhookRunRecord,
  WebhookRunStatus,
  WebhookRunStorage,
} from "./webhook-runs"
export { WebhookRunError } from "./webhook-runs"
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
export { WorkflowRunError } from "./workflow-runs"

export interface Storage {
  objects: ObjectStorage
  timeseries: TimeseriesStorage
  auth?: AuthStorage
  actionRuns?: ActionRunStorage
  syncRuns?: SyncRunStorage
  pipelineRuns?: PipelineRunStorage
  projectionRuns?: ProjectionRunStorage
  workflowRuns?: WorkflowRunStorage
  webhookDeliveries?: WebhookDeliveryStorage
  webhookRuns?: WebhookRunStorage
  rules?: RulesStorage
}
