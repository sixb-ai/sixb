// ── Ontology ────────────────────────────────────────────────

export type {
  ArraySchema,
  ComplexSchema,
  DirectLinkResult,
  DirectLinkTarget,
  EnumSchema,
  InferSchemaOrRef,
  Interface,
  LinkCardinality,
  LinkToken,
  LinkTokenMap,
  MapSchema,
  ObjectFieldSchema,
  ObjectLink,
  ObjectLinkTargetMetadata,
  ObjectLinkTargetType,
  ObjectRef,
  ObjectRefSchema,
  ObjectSchema,
  ObjectType,
  ObjectTypeSearchMetadata,
  ObjectTypeWithPropertyTokens,
  ObjectTypeWithTokens,
  Ontology,
  OntologyRegistryOptions,
  PrimitiveSchema,
  Property,
  PropertyMode,
  PropertyQueryMetadata,
  PropertyToken,
  PropertyTokenMap,
  Schema,
  SchemaOrRef,
  SixbObjectTypeMap,
  ValueType,
  ValueTypeRefSchema,
} from "./ontology"
export {
  createLinkTokenMap,
  createPropertyTokenMap,
  defineInterface,
  defineObjectType,
  defineOntology,
  defineValueType,
  integerEnum,
  isObjectRefSchema,
  link,
  OntologyRegistry,
  prop,
  ref,
  stringEnum,
  validateSchemaOrRefValue,
  valueTypeRef,
} from "./ontology"

// ── Actions ─────────────────────────────────────────────────

export type {
  ActionBinding,
  ActionBlobContext,
  ActionBuilder,
  ActionDefinition,
  ActionEditsContext,
  ActionEditsHandler,
  ActionEffectsContext,
  ActionEffectsHandler,
  ActionObjectSubject,
  ActionParamConfig,
  ActionParamsConfig,
  ActionReadFacade,
  ActionReadObjectByIdHandle,
  ActionReadObjectSet,
  ActionReadObjectSetSource,
  ActionRunPhaseInfo,
  ActionRuntimeFacade,
  ActionSubject,
  ActionTargetObject,
  ActionTelemetryObjectSet,
  ActionValidationContext,
  ActionValidator,
  ActionWritebackContext,
  ActionWritebackHandler,
  ActionWritebackValue,
  GlobalActionAfterEditsBuilder,
  GlobalActionAfterWritebackBuilder,
  GlobalActionDefinition,
  GlobalActionEditsContext,
  GlobalActionEditsHandler,
  GlobalActionEffectsContext,
  GlobalActionEffectsHandler,
  GlobalActionParamsBuilder,
  GlobalActionPhaseBuilder,
  GlobalActionValidationContext,
  GlobalActionValidator,
  GlobalActionWritebackContext,
  GlobalActionWritebackHandler,
  InferActionParams,
  ObjectActionAfterEditsBuilder,
  ObjectActionAfterWritebackBuilder,
  ObjectActionDefinition,
  ObjectActionParamsBuilder,
  ObjectActionPhaseBuilder,
  RequestActionAndWaitInput,
  RequestActionAndWaitOptions,
  RequestActionInput,
  RequestActionOptions,
  RequestActionResult,
  WaitForActionRunInput,
} from "./actions"
export {
  ActionDefinitionError,
  defineAction,
  isActionDefinition,
  isGlobalActionDefinition,
  isObjectActionDefinition,
  optional,
  param,
  requestAction,
  requestActionAndWait,
  waitForActionRun,
} from "./actions"
export {
  ActionRunFailedError,
  ActionRunTimeoutError,
  ActionValidationError,
} from "./objects/action"

// ── Datasets ────────────────────────────────────────────────

export type {
  DatasetColumnDefinition,
  DatasetColumnDefinitionOf,
  DatasetColumnNameOf,
  DatasetColumnType,
  DatasetColumnTypeOf,
  DatasetColumnUnionOf,
  DatasetDefinition,
  DatasetSchema,
} from "./datasets"
export {
  col,
  DatasetValidationError,
  defineDataset,
  getDatasetRowValidationError,
  isDatasetDefinition,
} from "./datasets"

// ── Broker ─────────────────────────────────────────────────

export type { Broker } from "./broker"
export { InMemoryBroker } from "./broker"
export type { JsonValue } from "./json"
export {
  assertJsonValue,
  cloneJsonValue,
  compareStrings,
  getInvalidJsonValueReason,
  isJsonValue,
  jsonValuesEqual,
  stableJsonStringify,
} from "./json"

// ── Quantitative Types (units) ──────────────────────────────

export type {
  QuantitativeType,
  QuantitativeTypeId,
  Unit,
  UnitId,
  UnitsOf,
} from "./ontology/units"
export {
  getUnit,
  getUnitSymbol,
  getUnitsFor,
  isQuantitativeTypeId,
  isUnitId,
  isValidUnit,
  quantitativeTypes,
} from "./ontology/units"

// ── Exact decimals ──────────────────────────────────────────

export type { DecimalValue } from "./ontology/decimal"
export {
  compareDecimalValues,
  decimal,
  isDecimalString,
  isDecimalValue,
  normalizeDecimalValue,
} from "./ontology/decimal"

// ── Ontology SDK typing ─────────────────────────────────────

export type {
  InferObjectProperties,
  InferPropertySemanticType,
  InferPropertyUnit,
  InferPropertyValue,
  InferSchema,
  InferTelemetryBatchProperties,
  InferTelemetryPropertyIds,
} from "./ontology/inference"

// ── Events ──────────────────────────────────────────────────

export type {
  ActionCompletedEvent,
  ActionEvent,
  ActionEventSelectorBuilder,
  ActionEventSelectorContext,
  ActionEventSelectorEvent,
  ActionEventSelectorOperation,
  ActionEventToken,
  ActionEventTokenOf,
  ActionFailedEvent,
  ActionRequestedEvent,
  DatasetEvent,
  DatasetEventSelectorBuilder,
  DatasetEventSelectorContext,
  DatasetEventSelectorEvent,
  DatasetEventToken,
  DatasetVersionCommittedEvent,
  DomainEvent,
  EventActor,
  EventOrigin,
  EventPropertySelector,
  EventScopeKeys,
  EventSelectorContext,
  EventSelectorEvent,
  EventSelectorSpec,
  EventSelectors,
  InferEventSelectorContext,
  InferEventSelectorEvent,
  LinkCreatedEvent,
  LinkDeletedEvent,
  LinkEvent,
  LinkEventSelectorBuilder,
  LinkEventSelectorContext,
  LinkEventSelectorEvent,
  LinkUpdatedEvent,
  ObjectCreatedEvent,
  ObjectDeletedEvent,
  ObjectEvent,
  ObjectEventSelectorBuilder,
  ObjectEventSelectorContext,
  ObjectEventSelectorEvent,
  ObjectUpdatedEvent,
  PipelineEvent,
  PipelineEventSelectorBuilder,
  PipelineEventSelectorContext,
  PipelineEventSelectorEvent,
  PipelineEventToken,
  PipelineRunFinishedEvent,
  PipelineRunStartedEvent,
  PipelineRunStepFinishedEvent,
  PipelineRunStepStartedEvent,
  PropertyChange,
  PropertyChangeMap,
  PropertyChangeOperation,
  RuleEvent,
  RuleEventSelectorBuilder,
  RuleEventSelectorContext,
  RuleEventSelectorEvent,
  RuleEventSelectorOperation,
  RuleEventSubject,
  RuleResolvedEvent,
  RuleTriggeredEvent,
  RunEventSelectorOperation,
  ScheduleEvent,
  ScheduleTriggeredEvent,
  SyncEvent,
  SyncEventSelectorBuilder,
  SyncEventSelectorContext,
  SyncEventSelectorEvent,
  SyncEventToken,
  SyncRunFinishedEvent,
  SyncRunStartedEvent,
  TelemetryAppendedEvent,
  TelemetryEvent,
  WorkflowEvent,
  WorkflowRunFinishedEvent,
  WorkflowRunNodeFinishedEvent,
  WorkflowRunNodeStartedEvent,
  WorkflowRunQueuedEvent,
  WorkflowRunStartedEvent,
} from "./events"
export {
  buildEventSelectorPredicate,
  eventSelectorSpec,
  events,
  getEventTopic,
  isDomainEventType,
} from "./events"

// ── Logging ─────────────────────────────────────────────────

export type {
  ConsoleLoggerOptions,
  LogContext,
  LogEntry,
  LogFields,
  Logger,
  LoggerProvider,
  LogLevel,
  LogRecord,
  LogRunKind,
  LogRunRef,
  LogsObservabilityOptions,
  ObservabilityOptions,
  StoredLogLine,
} from "./logging"
export {
  ConsoleLogger,
  isLevelEnabled,
  isLogLevel,
  isLogRecord,
  isLogRunKind,
  isStoredLogLine,
  LOG_LEVELS,
  LOG_RUN_KINDS,
  logLevelsAtOrAbove,
  noopLogger,
  noopLoggerProvider,
  normalizeLogError,
} from "./logging"

// ── Predicates ─────────────────────────────────────────────

export type {
  AllPredicate,
  AnyPredicate,
  FieldPredicate,
  LinkPredicate,
  LinkPredicateBuilder,
  LinkPredicateOperator,
  NotPredicate,
  Predicate,
  PredicateValue,
  PropertyPredicate,
  PropertyPredicateBuilder,
  PropertyPredicateOperator,
} from "./predicates"

// ── Rules ──────────────────────────────────────────────────

export type {
  RuleDefinition,
  RuleEventDependency,
  RulePredicate,
  RuleSubject,
} from "./rules"
export {
  defineRule,
  deriveRuleEventDependencies,
  isRuleDefinition,
  RuleValidationError,
} from "./rules"

// ── Auth ───────────────────────────────────────────────────

export type {
  AuthCookieOptions,
  AuthSessionAudience,
  AuthSessionAudienceOptions,
  AuthSessionOptions,
  AuthStrategy,
  AuthStrategyKind,
  Principal,
  SecurityContext,
  SixbAuthConfig,
} from "./auth"
export {
  DEFAULT_AUTH_SESSION_AUDIENCE,
  isValidAuthSessionAudience,
  principalsEqual,
  resolveAuthSessionAudience,
  SYSTEM_PRINCIPAL,
} from "./auth"

// ── Authorization ──────────────────────────────────────────

export type { AuthorizationContext } from "./authorization"
export {
  AuthorizationError,
  canAccessApplication,
  isAllowed,
  isApplicationAccessControlled,
  resolveAuthorizationContext,
} from "./authorization"

// ── Security Definitions ───────────────────────────────────

export type {
  AccessGrant,
  ApplicationDefinition,
  ApplyGrant,
  DefineGroupOptions,
  DefineMembershipPolicyOptions,
  DefineRoleOptions,
  GrantCapability,
  GrantDefinition,
  GroupDefinition,
  MembershipOperation,
  MembershipOperationScope,
  MembershipPolicyDefinition,
  MembershipPolicyScope,
  ObserveGrant,
  ObserveGrantTarget,
  RegisteredSecurityDefinitions,
  RoleDefinition,
  RunGrant,
  RunGrantTarget,
  Scope,
  ScopeTarget,
  SecurityRegistry,
  Selection,
  ViewGrant,
  ViewGrantTarget,
} from "./security"
export {
  actions,
  agents,
  applications,
  assertGrantDefinition,
  assertGroupDefinition,
  assertMembershipPolicyDefinition,
  assertRoleDefinition,
  can,
  canPerformMembershipOperation,
  datasets,
  defineGroup,
  defineMembershipPolicy,
  defineRole,
  isGroupDefinition,
  isMembershipOperation,
  isMembershipPolicyDefinition,
  isRoleDefinition,
  missingMembershipGroupIds,
  ontology,
  pipelines,
  resolveMembershipPolicyScope,
  SecurityValidationError,
  syncs,
  workflows,
} from "./security"

// ── Storage ────────────────────────────────────────────────
// Config contract + operator migration API + in-memory dev providers.
// The full storage-provider contract lives at `@sixb/core/storage`.

export type {
  MigrationCapableStorage,
  MigrationReport,
  Storage,
  StorageMigrationResult,
  StorageMigrator,
  StorageTransactionOptions,
} from "./storage"
export {
  InMemoryActionRunStorage,
  InMemoryAgentStorage,
  InMemoryAuthStorage,
  InMemoryFileUploadSessions,
  InMemoryObjectStorage,
  InMemoryPipelineRunStorage,
  InMemoryProjectionRunStorage,
  InMemoryRulesStorage,
  InMemoryStorage,
  InMemorySyncRunStorage,
  InMemoryTimeseriesStorage,
  InMemoryWebhookDeliveryStorage,
  InMemoryWebhookRunStorage,
  InMemoryWorkflowInterventionStorage,
  InMemoryWorkflowNodeRunStorage,
  InMemoryWorkflowRunStorage,
  isMigrationCapableStorage,
  migrateStorage,
} from "./storage"

// ── Blob Storage ───────────────────────────────────────────
// Browser-safe file value helpers + the config contract + in-memory provider.
// The Node blob-provider contract lives at `@sixb/core/blob-storage/server`.

export type {
  BlobBody,
  BlobByteRange,
  BlobDigest,
  BlobInfo,
  BlobStorage,
  FileRef,
} from "./blob-storage"
export {
  blobDigestHex,
  blobIdFromDigest,
  DEFAULT_SIMPLE_FILE_UPLOAD_BYTES,
  fileNameFor,
  InMemoryBlobStorage,
  isBlobDigest,
  isFileRef,
} from "./blob-storage"

// ── Lake Storage ───────────────────────────────────────────
// Config contract + in-memory dev provider. The full lake-provider contract lives at
// `@sixb/core/lake-storage`.

export type {
  DatasetProducer,
  DatasetRow,
  LakeStorage,
  LakeStorageWithSql,
} from "./lake-storage"
export { InMemoryLakeStorage } from "./lake-storage"

// ── Queues ─────────────────────────────────────────────────
// Config contract + in-memory dev provider. The full queue-provider contract lives at
// `@sixb/core/queues`.

export type { Queue, Queues } from "./queues"
export { InMemoryQueues } from "./queues"

// ── Sandboxes ──────────────────────────────────────────────

export type {
  CommandResult,
  CreateSandboxOptions,
  ExecOptions,
  RunCommandOptions,
  Sandbox,
  SandboxFactory,
  SandboxFileRecord,
  SandboxNetworkPolicy,
  SandboxNetworkTarget,
  SandboxStatus,
} from "./sandboxes"
export {
  SandboxError,
  SandboxIsolationUnavailableError,
  SandboxNotRunningError,
  SandboxTimeoutError,
} from "./sandboxes"

// ── Object Queries ──────────────────────────────────────────
// Query IR types + user-catchable errors. The planner/executor engine lives at
// `@sixb/core/internal/query`; the browser-safe builder at `@sixb/core/query`.

export type {
  ObjectExpansion,
  ObjectQuery,
  ObjectQueryDirection,
  ObjectQueryExpand,
  ObjectQueryFilter,
  ObjectQueryLimit,
  ObjectQueryPage,
  ObjectQueryPredicate,
  ObjectQueryPredicateComparison,
  ObjectQueryPredicateContains,
  ObjectQueryPredicateExists,
  ObjectQueryPredicateGroup,
  ObjectQueryPredicateIn,
  ObjectQueryPredicateNot,
  ObjectQueryProject,
  ObjectQueryResultShape,
  ObjectQuerySet,
  ObjectQuerySetOperation,
  ObjectQuerySort,
  ObjectQuerySortDirection,
  ObjectQuerySortField,
  ObjectQueryStart,
  ObjectQueryText,
  ObjectQueryTraverse,
  ObjectQueryValidationIssue,
  ObjectQueryValidationOptions,
  ObjectQueryVector,
  QueryScalarKind,
  ValidatedObjectQuery,
} from "./objects/query"
export {
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
} from "./objects/query"

// ── Connectors ─────────────────────────────────────────────

export type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorContext,
  ConnectorDefinition,
} from "./connectors"
export { defineConnector } from "./connectors"

// ── Webhooks ───────────────────────────────────────────────

export type {
  RegisteredWebhook,
  WebhookBodyFormat,
  WebhookBodyParser,
  WebhookBodySchema,
  WebhookConnectorClient,
  WebhookDefinition,
  WebhookHandlerContext,
  WebhookHandlerResult,
  WebhookIdempotencyContext,
  WebhookIdempotencyKeyResolver,
  WebhookMetadata,
  WebhookResponse,
  WebhookVerifyContext,
} from "./webhooks"
export { defineWebhook, WebhookValidationError, webhookConnector } from "./webhooks"

// ── Syncs ──────────────────────────────────────────────────

export type {
  BatchSyncConfig,
  BatchSyncDefinitionConfig,
  DatasetSyncTarget,
  SyncBuilder,
  SyncDefinition,
  SyncReadBuilder,
  SyncReadContext,
  SyncReadHandler,
  SyncReadResult,
  SyncTargetBuilder,
} from "./syncs"
export { defineSync } from "./syncs"

// ── Schedules ───────────────────────────────────────────────

export type {
  CronScheduleBuilder,
  CronScheduleDefinition,
  CronScheduleTriggerDefinition,
  EventScheduleBuilder,
  EventScheduleCondition,
  EventScheduleConditionFor,
  EventScheduleConditionScope,
  EventScheduleDefinition,
  EventSchedulePredicateContext,
  EventSchedulePropertyPredicateBuilder,
  EventScheduleSourceBuilder,
  EventScheduleTargetPredicateSubject,
  EventScheduleTriggerDefinition,
  EventScheduleWhereBuilder,
  InferScheduleEvent,
  ScheduleBuilder,
  ScheduleDefinition,
  ScheduleDefinitionForEvent,
  ScheduleReference,
  ScheduleTriggerDefinition,
} from "./schedules"
export {
  assertScheduleDefinition,
  defineSchedule,
  isScheduleDefinition,
  isScheduleReference,
  ScheduleValidationError,
} from "./schedules"

// ── Pipelines ───────────────────────────────────────────────

export type {
  PipelineBuilder,
  PipelineDefinition,
  PipelineGraph,
  PipelineSequenceGraph,
  PipelineStepDefinition,
  PipelineStepExecutor,
  PipelineStepExecutorBuilder,
  PipelineStepInput,
  PipelineStepInputBuilder,
  PipelineStepNode,
  PipelineStepOutput,
  PipelineStepOutputBuilder,
  PipelineStepOutputOptions,
  PipelineStepRunContext,
  PipelineStepRunHandler,
} from "./pipelines"
export {
  definePipeline,
  definePipelineStep,
  isPipelineDefinition,
  isPipelineStepDefinition,
  PipelineError,
} from "./pipelines"

// ── Workflows ───────────────────────────────────────────────

export type {
  InferInterventionInput,
  InferInterventionResponse,
  InferStepInput,
  InferStepOutput,
  InferWorkflowContract,
  InferWorkflowInput,
  InterventionBuilder,
  InterventionDefaultsHandler,
  InterventionDefaultsRuntimeHandler,
  InterventionDefinition,
  InterventionFieldConfig,
  InterventionResponseBuilder,
  InterventionResponseConfig,
  InterventionResponseDraftBuilder,
  InterventionResponseField,
  RequestWorkflowRunInput,
  StepBuilder,
  StepDefinition,
  StepHandler,
  StepOutputBuilder,
  StepRunBuilder,
  StepRunContext,
  WorkflowActionDefinition,
  WorkflowActionMapper,
  WorkflowActionMapperResult,
  WorkflowBuilder,
  WorkflowChainDefinition,
  WorkflowDefinition,
  WorkflowDraftBuilder,
  WorkflowMapperContext,
  WorkflowRunRequestOptions,
  WorkflowRunRequestResult,
  WorkflowRunSource,
  WorkflowScheduleMapper,
  WorkflowScheduleTriggerDefinition,
  WorkflowStepMapper,
  WorkflowStepOutputs,
  WorkflowTriggerDefinition,
} from "./workflows"
export {
  defineIntervention,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  isInterventionDefinition,
  isStepDefinition,
  isWorkflowDefinition,
  requestWorkflowRun,
  WorkflowDefinitionError,
  WorkflowValidationError,
} from "./workflows"

// ── Runtime ─────────────────────────────────────────────────

export type {
  SixbErrorContext,
  SixbErrorHandler,
  SixbFailedRun,
  SixbRunFailedContext,
} from "./error-reporting/types"
export type {
  BatchItemResult,
  CreateSixbOptions,
  ListResult,
  ListResultWithoutTotal,
  ObjectByIdHandle,
  ObjectExpandBuilder,
  ObjectExpandOptions,
  ObjectExpansionSort,
  ObjectQueryBuilder,
  ObjectQueryFacetBucket,
  ObjectQueryFacetInput,
  ObjectQueryFacetResult,
  ObjectQueryListOptions,
  ObjectQueryRow,
  ObjectSet,
  ObjectSetListInput,
  ObjectSetQueryPropertyToken,
  ObjectWhereBuilder,
  ObjectWhereClause,
  OntologyDocumentInput,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
  ScopedObjectByIdHandle,
  ScopedObjectSet,
  ScopedSixb,
  SixbInstance,
  SixbOptions,
  SixbRuntimeContext,
  TelemetryAppender,
  TelemetryAppendInput,
  TelemetryPropertyToken,
  TwinObject,
} from "./runtime"
export {
  ConnectorError,
  ConnectorNotFoundError,
  createSixb,
  FunctionError,
  FunctionValidationError,
  ObjectError,
  ObjectNotFoundError,
  OntologyValidationError,
  ProjectionValidationError,
  RuntimeError,
  Sixb,
  SyncValidationError,
} from "./runtime"

// ── Functions ───────────────────────────────────────────────

export type {
  CronFunctionBuilder,
  CronHandler,
  CronTriggerDefinition,
  FunctionBuilder,
  FunctionContext,
  FunctionDefinition,
  FunctionMetadata,
  IntervalFunctionBuilder,
  IntervalHandler,
  IntervalTriggerDefinition,
  TriggerDefinition,
} from "./functions"
export { defineFunction } from "./functions"

// ── Agents ──────────────────────────────────────────────────

export type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentContextOrigin,
  AgentContextPart,
  AgentDefinition,
  AgentFileDataProjection,
  AgentFileDataResolverInput,
  AgentFilePart,
  AgentInboundUiMessage,
  AgentInboundUiMessagePart,
  AgentLoopConfig,
  AgentMessage,
  AgentMessagePart,
  AgentMessagePartType,
  AgentMessageRole,
  AgentModelAssistantPart,
  AgentModelFilePart,
  AgentModelMessage,
  AgentModelReasoningPart,
  AgentModelTextPart,
  AgentModelToolCallPart,
  AgentModelToolOutput,
  AgentModelToolResultPart,
  AgentReasoningLevel,
  AgentReasoningPart,
  AgentRequestErrorCode,
  AgentStepStartPart,
  AgentTextPart,
  AgentToolCallPart,
  AgentToolCallState,
  AgentUiMessage,
  AgentUiMessagePart,
  AgentUiToolPart,
  DefineAgentConfig,
  RequestAgentRunInput,
  RequestAgentRunResult,
} from "./agents"
export {
  AGENT_REASONING_LEVELS,
  AgentDefinitionError,
  AgentRequestError,
  agentContext,
  agentContextIdentity,
  defineAgent,
  isAgentDefinition,
  MAX_AGENT_APP_STATE_ENTRY_BYTES,
  MAX_AGENT_APP_STATE_TOTAL_BYTES,
  MAX_AGENT_CONTEXT_ENTRIES,
  requestAgentRun,
} from "./agents"

// ── Scheduling ──────────────────────────────────────────────

export { CronValidationError, createCronMatcher, nextCronOccurrence } from "./schedules"

// ── Projections ─────────────────────────────────────────────

export type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  ProjectionObjectTypeIds,
  TelemetryProjectionDefinition,
} from "./projections"

export {
  defineLinkProjection,
  defineProjection,
  defineTelemetryProjection,
  fromForeignKey,
  isLinkProjectionDefinition,
  isObjectProjectionDefinition,
  isProjectionDefinition,
  isTelemetryProjectionDefinition,
  projectionKindOf,
  projectionObjectTypeIds,
  validateTelemetryProjectionFieldMapping,
} from "./projections"
