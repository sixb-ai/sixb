import type {
  ObjectQueryCapabilities,
  ObjectStorage,
  OntologyOutboxFailureCode,
  OntologyOutboxRecord,
  QueryObjectsInput,
  QueryObjectsResult,
  WebhookDeliveryFailureCode,
  WebhookDeliveryRecord,
} from "../src/storage"

const outboxFailureCode: OntologyOutboxFailureCode = "event.delivery_failed"
const storedOutboxFailureCode: NonNullable<OntologyOutboxRecord["lastFailure"]>["code"] =
  outboxFailureCode
// @ts-expect-error The outbox exposes only its declared delivery-failure code.
const unrelatedOutboxFailureCode: OntologyOutboxFailureCode = "internal.unexpected"

void storedOutboxFailureCode
void unrelatedOutboxFailureCode

const deliveryFailureCode: WebhookDeliveryFailureCode = "webhook.delivery_failed"
const storedDeliveryFailureCode: NonNullable<WebhookDeliveryRecord["failure"]>["code"] =
  deliveryFailureCode
// @ts-expect-error The delivery journal exposes only its retryable delivery-failure code.
const unrelatedDeliveryFailureCode: WebhookDeliveryFailureCode = "internal.unexpected"

void storedDeliveryFailureCode
void unrelatedDeliveryFailureCode

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
