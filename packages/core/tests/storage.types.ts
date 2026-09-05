import type {
  ConsumeConnectorAuthorizationAttemptInput,
  InMemoryConnectorConnectionStorageSnapshot,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectStorage,
  OntologyOutboxFailureCode,
  OntologyOutboxRecord,
  QueryObjectsInput,
  QueryObjectsResult,
  WebhookRunFailureCode,
  WebhookRunRecord,
} from "../src/storage"

const connectorAttemptInput = {} as ConsumeConnectorAuthorizationAttemptInput
const connectorStorageSnapshot = {} as InMemoryConnectorConnectionStorageSnapshot

void connectorAttemptInput
void connectorStorageSnapshot

const outboxFailureCode: OntologyOutboxFailureCode = "event.delivery_failed"
const storedOutboxFailureCode: NonNullable<OntologyOutboxRecord["lastFailure"]>["code"] =
  outboxFailureCode
// @ts-expect-error The outbox exposes only its declared delivery-failure code.
const unrelatedOutboxFailureCode: OntologyOutboxFailureCode = "internal.unexpected"

void storedOutboxFailureCode
void unrelatedOutboxFailureCode

const webhookFailureCode: WebhookRunFailureCode = "webhook.delivery_failed"
const storedWebhookFailureCode: NonNullable<WebhookRunRecord["error"]>["code"] = webhookFailureCode
// @ts-expect-error Webhook runs expose only their declared delivery-failure codes.
const unrelatedWebhookFailureCode: WebhookRunFailureCode = "runtime.cancelled"

void storedWebhookFailureCode
void unrelatedWebhookFailureCode

const capabilities: ObjectQueryCapabilities = {
  queryObjects: true,
  nodes: {
    start: true,
    filter: true,
    limit: true,
  },
  predicateOps: {
    and: true,
    eq: true,
  },
  sortKinds: {
    property: true,
  },
  traversalDirections: {
    outgoing: true,
  },
  setOps: {
    union: true,
  },
  limits: {
    maxLimit: 100,
    totalCount: true,
  },
}

const queryObjects = async (input: QueryObjectsInput): Promise<QueryObjectsResult> => {
  void input.projectId
  void input.query
  return {
    objects: [],
    hasMore: false,
    total: 0,
  }
}

const providerQuerySurface: Pick<ObjectStorage, "queryCapabilities" | "queryObjects"> = {
  queryCapabilities: () => capabilities,
  queryObjects,
}

void providerQuerySurface

const objectReader = {} as ObjectReadStorage
void objectReader.selectsObjectProperties
void objectReader.listLinksBatch
void objectReader.queryLinks
// @ts-expect-error Internal materialization reads are deliberately absent from the safe reader.
void objectReader.listIncidentLinksBatch
// @ts-expect-error Background reconciliation reads are deliberately absent from the safe reader.
void objectReader.listByPrimaryIdPage
