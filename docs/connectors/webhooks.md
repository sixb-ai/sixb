# Webhooks

Webhooks let external services notify your Sixb project when something changes.

## Define a webhook

Add `webhooks` to a connector adapter in `connectors/`. Use `defineWebhook()` to validate the
payload, verify the sender, and handle the event.

This example receives a CRM event, fetches the current person, and updates a dataset:

```ts
import { change, defineConnector, defineWebhook } from "@sixb/core"
import { people } from "../datasets/people"
import { createCrmClient, personEventSchema, verifyCrmSignature } from "../lib/crm"

export const crm = defineConnector("crm", {
  type: "crm",
  connect: () => createCrmClient(),
  webhooks: [
    defineWebhook("person-updated")
      .post()
      .json(personEventSchema)
      .verify(({ request, rawBody }) => verifyCrmSignature(request, rawBody))
      .idempotencyKey(({ body }) => body.deliveryId)
      .handle(async ({ body, client, sixb }) => {
        const crm = await client()
        const person = await crm.getPerson(body.personId)

        await sixb.datasets.ingest(people, {
          changes: [change.upsert({
            id: String(person.id),
            name: person.name,
            updatedAt: person.updatedAt,
          })],
        })
      }),
  ],
})
```

The `../lib/crm` imports are your provider-specific code: a client factory, a schema with
`parse(unknown)` returning `{ personId, deliveryId }`, and a signature verifier that throws when
verification fails. Verify signatures using the provider's documented method and the original
`rawBody` bytes.

The example uses the [`people` dataset](../datasets/source-ordering.md). See
[ingesting changes](../datasets/ingestion.md) for dataset updates and deletes.

## Register the URL

Register your webhook's URL with the external service:

```text
https://<sixb-api-origin>/api/webhooks/crm/person-updated
```

The last two segments are the connector ID and webhook ID. Sixb registers the route automatically
and returns `202 Accepted` when the handler completes without an explicit response. Return
`{ status: 200 }` from the handler if your provider requires it.

Providers may retry deliveries. Use a stable delivery ID with `.idempotencyKey()` to deduplicate
requests, and make handler writes safe to repeat. A failed handler can have already completed
some of its writes.

## OAuth accounts

For [OAuth connectors](authentication.md), resolve the account named in the event before accessing
its client. Inside your webhook handler:

```ts
.handle<ProviderClient>(async ({ body, connections }) => {
  for (const account of await connections.forAccount(body.accountId)) {
    const client = await account.client()
    await handleProviderEvent(client, body)
  }
})
```

`ProviderClient` is your adapter's client type, and `handleProviderEvent` is your event handler.
`connections.forAccount()` returns all matching connected accounts, or an empty array when none
match. The top-level `client()` used in the first example is for connectors without managed OAuth.
