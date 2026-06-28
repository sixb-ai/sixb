# @sixb/connector-pandadoc

PandaDoc connector for Sixb, built on `@sixb/connector-rest`.

The connector models the PandaDoc public API one-to-one, excluding OAuth token exchange:

- Documents, document fields, recipients, linked objects, reminders, attachments, sections, settings,
  audit trail, DSV named items, quotes, and beta document intelligence endpoints
- Templates, content library items, forms, contacts, members, folders, logs, product catalog, notary,
  workspaces, users, SMS opt-outs, and webhooks
- Verified inbound PandaDoc webhook events

The connector keeps PandaDoc response shapes intact. It does not map PandaDoc records into Sixb
ontology objects or normalize document details.

## Register

Drop this in your project's `connectors/` directory. `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { pandadoc } from "@sixb/connector-pandadoc"

export const pandadocConnector = defineConnector(
  "pandadoc",
  pandadoc({
    apiKey: process.env.PANDADOC_API_KEY!,
    webhookSharedKey: process.env.PANDADOC_WEBHOOK_SHARED_KEY,
  })
)
```

| Option | Description |
| --- | --- |
| `apiKey` | Required. PandaDoc API key, or a resolver returning one. Sent as `Authorization: API-Key <key>`. |
| `baseUrl` | API base URL. Defaults to `https://api.pandadoc.com/`. |
| `timeoutMs` | Optional per-request timeout passed to `@sixb/connector-rest`. |
| `minDelayMs` | Optional minimum delay between outbound requests. |
| `retry` | Optional REST retry policy. Defaults to two retries for retryable responses. |
| `webhookSharedKey` | Optional shared key used to verify inbound webhook signatures. Set this in production. |
| `onEvent` | Optional handler for inbound PandaDoc webhook events. |

PandaDoc API keys are workspace-scoped and inherit the key owner's permissions. Use a dedicated
service account per workspace when possible.

## Client API

```ts
const pd = await sixb.connector(pandadocConnector)
```

| Method | Endpoint |
| --- | --- |
| `pd.documents.list(opts?)` / `listAll` | `GET /public/v1/documents` |
| `pd.documents.create(input, opts?)` / `createFromUpload` / `createFromMarkdownUpload` | `POST /public/v1/documents*` |
| `pd.documents.bulkDelete(input)` | `DELETE /public/v1/documents` |
| `pd.documents.status(id)` | `GET /public/v1/documents/{id}` |
| `pd.documents.details(id)` | `GET /public/v1/documents/{id}/details` |
| `pd.documents.update(id, input)` / `delete(id)` | `PATCH` / `DELETE /public/v1/documents/{id}` |
| `pd.documents.changeStatus(id, input)` / `changeStatusWithUpload` | `PATCH /public/v1/documents/{id}/status*` |
| `pd.documents.moveToDraft(id)` | `POST /public/v1/documents/{id}/draft` |
| `pd.documents.send(id, input?)` | `POST /public/v1/documents/{id}/send` |
| `pd.documents.createSession(id, input)` | `POST /public/v1/documents/{id}/session` |
| `pd.documents.createEditingSession(id, input)` | `POST /public/v1/documents/{id}/editing-sessions` |
| `pd.documents.download(id, opts?)` | `GET /public/v1/documents/{id}/download` |
| `pd.documents.downloadProtected(id, opts?)` | `GET /public/v1/documents/{id}/download-protected` |
| `pd.documents.eSignDisclosure(id)` | `GET /public/v1/documents/{id}/esign-disclosure` |
| `pd.documents.transferOwnership` / `transferAllOwnership` | `/public/v1/documents*/ownership` |
| `pd.documents.moveToFolder` / `appendContentLibraryItem` / `sendReminder` | `/public/v1/documents/{id}/*` |
| `pd.documentFields.list(documentId)` / `create` / `updateAssignments` | `/public/v1/documents/{id}/fields` |
| `pd.documentRecipients.add(documentId, input)` / `update` / `delete` / `reassign` | `/public/v1/documents/{id}/recipients*` |
| `pd.documentLinkedObjects.listDocuments({ provider, entity_type, entity_id })` | `GET /public/v1/documents/linked-objects` |
| `pd.documentLinkedObjects.list(documentId)` / `create` / `delete` | `/public/v1/documents/{id}/linked-objects*` |
| `pd.documentAutoReminders.*` | `/public/v1/documents/{id}/auto-reminders*` |
| `pd.documentAttachments.*` | `/public/v1/documents/{id}/attachments*` |
| `pd.documentAuditTrail.list(documentId)` | `GET /public/v2/documents/{id}/audit-trail` |
| `pd.documentSettings.*` | `/public/v2/documents/{id}/settings` |
| `pd.documentSections.*` | `/public/v1/documents/{id}/sections*` |
| `pd.documentDsv.addNamedItems(documentId, input)` | `POST /public/v2/dsv/{id}/add-named-items` |
| `pd.templates.*` | `/public/v1/templates*` and `/public/v2/templates/{id}/settings` |
| `pd.contacts.list(opts?)` / `listAll` / `create` / `get` / `update` / `delete` | `/public/v1/contacts*` |
| `pd.contentLibraryItems.*` | `/public/v1/content-library-items*` |
| `pd.forms.list(opts?)` / `listAll` | `GET /public/v1/forms` |
| `pd.members.list()` / `listAll` / `current` / `get` / `createToken` | `/public/v1/members*` |
| `pd.folders.documents.*` | `/public/v1/documents/folders*` |
| `pd.folders.templates.*` | `/public/v1/templates/folders*` |
| `pd.logs.v1.*` / `pd.logs.v2.*` | `/public/v1/logs*` and `/public/v2/logs*` |
| `pd.notary.*` | `/public/v2/notary/*` |
| `pd.productCatalog.*` | `/public/v2/product-catalog/items*` |
| `pd.quotes.update(documentId, quoteId, input)` | `PUT /public/v1/documents/{id}/quotes/{quote_id}` |
| `pd.workspaces.*` / `pd.users.*` | `/public/v1/workspaces*` and `/public/v1/users*` |
| `pd.smsOptOuts.listRecent(opts?)` | `GET /public/v1/sms-opt-outs` |
| `pd.betaDocuments.*` | `/public/beta/documents*` |
| `pd.webhookSubscriptions.*` | `/public/v1/webhook-subscriptions*` |
| `pd.webhookEvents.list(opts?)` / `listAll` / `get` | `/public/v1/webhook-events*` |

Example document sync:

```ts
for await (const document of pd.documents.listAll({ status: "document.completed", count: 100 })) {
  const details = await pd.documents.details(document.id)
  // Map into a dataset or Sixb object.
}
```

PandaDoc list filters require numeric status codes, but this connector accepts known document status
strings and serializes them to PandaDoc's code values for `status` and `status__ne`.

## Pagination

PandaDoc list endpoints use page/count pagination. `listAll(...)` starts at `page` or `1`, preserves
the requested `count`, and stops on an empty page or a page shorter than the requested count. It does
not silently increase page size.

## Downloads

Document and attachment download methods return the raw `Response`, so callers can stream or buffer
files as needed:

```ts
const response = await pd.documents.downloadProtected(documentId)
const pdf = await response.arrayBuffer()
```

## Uploads

Upload endpoints accept native fetch body types. Use `FormData` for PandaDoc multipart endpoints:

```ts
const form = new FormData()
form.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "proposal.pdf")
form.set("data", JSON.stringify({ name: "Proposal" }))

await pd.documents.createFromUpload(form)
```

## Webhooks

Create a PandaDoc webhook subscription pointing to:

```txt
https://<sixb-host>/api/webhooks/pandadoc/events
```

Configure `onEvent` to receive each event in PandaDoc's array payload:

```ts
pandadoc({
  apiKey: process.env.PANDADOC_API_KEY!,
  webhookSharedKey: process.env.PANDADOC_WEBHOOK_SHARED_KEY!,
  onEvent: async ({ event, client }) => {
    if (event.event === "document_state_changed" && typeof event.data.id === "string") {
      const pd = await client()
      const document = await pd.documents.details(event.data.id)
      // Use fresh details when you need complete recipient links or optional payload fields.
    }
  },
})
```

When `webhookSharedKey` is set, deliveries must include PandaDoc's `signature` query parameter. The
connector verifies the HMAC-SHA256 hex digest over the raw request body before parsing JSON. Without
`webhookSharedKey`, signature verification is skipped for local development.

## Errors

Non-2xx PandaDoc responses throw `PandaDocApiError`.

```ts
import { PandaDocApiError } from "@sixb/connector-pandadoc"

try {
  await pd.documents.status("missing")
} catch (error) {
  if (error instanceof PandaDocApiError) {
    console.log(error.status, error.responseBody)
  }
}
```

## Not covered yet

- OAuth authorization-code flow and token refresh
