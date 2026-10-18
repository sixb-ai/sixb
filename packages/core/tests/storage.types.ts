import type {
  ConsumeConnectorAuthorizationAttemptInput,
  InMemoryConnectorConnectionStorageSnapshot,
  ObjectReadStorage,
  OntologyOutboxFailureCode,
  OntologyOutboxRecord,
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

const objectReader = {} as ObjectReadStorage
void objectReader.selectsObjectProperties
void objectReader.listLinksBatch
void objectReader.queryLinks
// @ts-expect-error Internal materialization reads are deliberately absent from the safe reader.
void objectReader.listIncidentLinksBatch
// @ts-expect-error Background reconciliation reads are deliberately absent from the safe reader.
void objectReader.listByPrimaryIdPage
