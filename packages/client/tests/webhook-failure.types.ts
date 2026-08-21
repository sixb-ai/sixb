import type { ListWebhookRunsResponses } from "../src/generated/types.gen"

type WebhookRun = ListWebhookRunsResponses[200]["runs"][number]
type WebhookRunFailureCode = NonNullable<WebhookRun["error"]>["code"]

const unexpected: WebhookRunFailureCode = "internal.unexpected"
const deliveryFailed: WebhookRunFailureCode = "webhook.delivery_failed"

// Webhook runs have no cancellation state, so cancellation is not part of their failure contract.
// @ts-expect-error the generated webhook failure contract must stay scoped to its lifecycle
const cancelled: WebhookRunFailureCode = "runtime.cancelled"
// @ts-expect-error HTTP route failures do not belong to persisted webhook-run failures
const unrelated: WebhookRunFailureCode = "dataset.not_found"

void [unexpected, deliveryFailed, cancelled, unrelated]
