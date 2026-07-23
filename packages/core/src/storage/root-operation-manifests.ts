/**
 * Static method manifests and composite façade factories for lock-unaware storage implementations.
 *
 * Each `*_ROOT_OPERATION_METHODS` manifest lists the async methods a lock-unaware store exposes
 * that must serialize against the root transaction lock. {@link rootOperationMethods} type-checks
 * each manifest against its store, so a drifting manifest fails to compile. Stores whose namespaces
 * are nested (auth, agents, workflow runs) get a dedicated factory that wraps every child store.
 */

import type { ActionRunStorage } from "./action-runs"
import type { AgentMessageStore, AgentRunStore, AgentStorage, AgentThreadStore } from "./agents"
import type {
  AuthAccessTokenStore,
  AuthGroupMembershipStore,
  AuthInvitationStore,
  AuthMagicLinkStore,
  AuthOidcAuthorizationAttemptStore,
  AuthServiceAccountGroupMembershipStore,
  AuthServiceAccountStore,
  AuthSessionStore,
  AuthStorage,
  AuthUserIdentityStore,
  AuthUserStore,
} from "./auth"
import type { FileUploadSessionStore } from "./file-upload-sessions"
import type { ObjectStorage } from "./objects"
import type { PipelineRunStorage } from "./pipeline-runs"
import type { ProjectionRunStorage } from "./projection-runs"
import {
  createRootOperationFacade,
  type RootOperationRunner,
  rootOperationMethods,
} from "./root-operation-facade"
import type { RulesStorage } from "./rules"
import type { SyncRunStorage } from "./sync-runs"
import type { TimeseriesStorage } from "./timeseries"
import type { WebhookDeliveryStorage } from "./webhook-deliveries"
import type { WebhookRunStorage } from "./webhook-runs"
import type { WorkflowInterventionStorage } from "./workflow-interventions"
import type { WorkflowNodeRunStorage, WorkflowRunStorage } from "./workflow-runs"

export const OBJECT_ROOT_OPERATION_METHODS = rootOperationMethods<ObjectStorage>({
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

export const TIMESERIES_ROOT_OPERATION_METHODS = rootOperationMethods<TimeseriesStorage>({
  applyTelemetryAppended: true,
  applyTelemetryAppendedBatch: true,
  getHistory: true,
  getHistoryBatch: true,
  getLatest: true,
})

export const ACTION_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<ActionRunStorage>({
  assertMaterializationRun: true,
  queue: true,
  start: true,
  enterPhase: true,
  recordWriteback: true,
  recordCommit: true,
  recordEffects: true,
  finish: true,
  getById: true,
  list: true,
})

export const PROJECTION_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<ProjectionRunStorage>({
  startOrReclaimMaterialization: true,
  assertMaterializationExecution: true,
  updateMaterialization: true,
  finishMaterialization: true,
  advanceTelemetryCheckpoint: true,
  completeEmptyTelemetryInput: true,
  start: true,
  update: true,
  finish: true,
  getById: true,
  list: true,
  listLatestByProjectionIds: true,
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

export const SYNC_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<SyncRunStorage>({
  start: true,
  finish: true,
  getById: true,
  list: true,
  listLatestBySyncIds: true,
})

export const PIPELINE_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<PipelineRunStorage>({
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

export const WORKFLOW_INTERVENTION_ROOT_OPERATION_METHODS =
  rootOperationMethods<WorkflowInterventionStorage>({
    create: true,
    submit: true,
    cancel: true,
    expire: true,
    getById: true,
    list: true,
  })

export const WEBHOOK_DELIVERY_ROOT_OPERATION_METHODS = rootOperationMethods<WebhookDeliveryStorage>(
  {
    claim: true,
    complete: true,
    fail: true,
  }
)

export const WEBHOOK_RUN_ROOT_OPERATION_METHODS = rootOperationMethods<WebhookRunStorage>({
  start: true,
  finish: true,
  getById: true,
  list: true,
})

export const RULES_ROOT_OPERATION_METHODS = rootOperationMethods<RulesStorage>({
  getActive: true,
  listActive: true,
  applyTriggered: true,
  applyResolved: true,
})

export const FILE_UPLOAD_SESSION_ROOT_OPERATION_METHODS =
  rootOperationMethods<FileUploadSessionStore>({
    create: true,
    getForPrincipal: true,
    markUploaded: true,
    addSignedPart: true,
    complete: true,
    abort: true,
    cleanupExpired: true,
  })

export function createAuthStorageFacade<T extends AuthStorage>(
  target: T,
  runRootOperation: RootOperationRunner
): T {
  return createRootOperationFacade<AuthStorage>(
    target,
    AUTH_ROOT_OPERATION_METHODS,
    runRootOperation,
    {
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
    }
  ) as T
}

export function createAgentStorageFacade<T extends AgentStorage>(
  target: T,
  runRootOperation: RootOperationRunner
): T {
  return createRootOperationFacade<AgentStorage>(
    target,
    AGENT_ROOT_OPERATION_METHODS,
    runRootOperation,
    {
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
    }
  ) as T
}

export function createWorkflowRunStorageFacade<T extends WorkflowRunStorage>(
  target: T,
  runRootOperation: RootOperationRunner
): T {
  return createRootOperationFacade<WorkflowRunStorage>(
    target,
    WORKFLOW_RUN_ROOT_OPERATION_METHODS,
    runRootOperation,
    {
      nodes: createRootOperationFacade(
        target.nodes,
        WORKFLOW_NODE_RUN_ROOT_OPERATION_METHODS,
        runRootOperation
      ),
    }
  ) as T
}
