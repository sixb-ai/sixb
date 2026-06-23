# @sixb/connector-teamleader

Teamleader Focus connector for Sixb.

V1 covers read access for:

- Deals
- Quotations
- Contacts
- Companies
- Custom field definitions

The connector expects an already valid Teamleader access token. It does not implement OAuth,
refresh tokens, or token storage.

## Usage

```ts
import { createTeamleaderClient } from "@sixb/connector-teamleader"

const client = createTeamleaderClient({
  accessToken: process.env.TEAMLEADER_ACCESS_TOKEN!,
})

const deals = await client.deals.list({
  page: { size: 20 },
  includes: "custom_fields",
})

const deal = await client.deals.info({ id: deals.data[0]!.id })
```

`accessToken` can be a string or a resolver:

```ts
const client = createTeamleaderClient({
  accessToken: async () => getValidAccessToken(),
})
```

Responses keep the Teamleader envelope:

```ts
{
  data: [...],
  meta: { ... },
  included: { ... },
}
```

## Client API

```ts
client.deals.list(...)
client.deals.listAll(...)
client.deals.info(...)

client.quotations.list(...)
client.quotations.listAll(...)
client.quotations.info(...)

client.contacts.list(...)
client.contacts.listAll(...)
client.contacts.info(...)

client.companies.list(...)
client.companies.listAll(...)
client.companies.info(...)

client.customFieldDefinitions.list(...)
client.customFieldDefinitions.listAll(...)
client.customFieldDefinitions.info(...)
```

`listAll(...)` is an async iterator over paginated Teamleader list endpoints.

```ts
for await (const deal of client.deals.listAll({ includes: "custom_fields" })) {
  // ...
}
```

## Custom Fields

Teamleader returns custom fields as raw definition/value pairs:

```ts
deal.custom_fields
```

Helpers are available for common lookups:

```ts
import { customFieldsByDefinitionId, customFieldsByLabel } from "@sixb/connector-teamleader"

const valuesById = customFieldsByDefinitionId(deal.custom_fields)
const valuesByLabel = customFieldsByLabel(deal.custom_fields, definitions.data)
```

Opportunity custom field definitions can be returned by Teamleader with context `sale`.
The connector also keeps `deal` as a supported context because it is documented by Teamleader.

## Sixb Adapter

```ts
import { teamleader } from "@sixb/connector-teamleader"

export default teamleader({
  accessToken: async () => getValidAccessToken(),
})
```

## Webhooks

The client exposes Teamleader webhook registration endpoints:

```ts
await client.webhooks.list()
await client.webhooks.register({ url, types: ["deal.updated"] })
await client.webhooks.unregister({ url, types: ["deal.updated"] })
```

Inbound webhook helpers are intentionally typed only:

```ts
import { defineTeamleaderWebhook } from "@sixb/connector-teamleader"

type DealUpdatedBody = {
  readonly type: "deal.updated"
  readonly subject: { readonly type: "deal"; readonly id: string }
}

export const webhook = defineTeamleaderWebhook<DealUpdatedBody>("events").handle(({ body }) => {
  return { status: 200, body: { id: body.subject.id } }
})
```

No inbound signature or payload validation is assumed by default.

## Errors

Non-2xx Teamleader responses throw `TeamleaderApiError`.

```ts
import { TeamleaderApiError } from "@sixb/connector-teamleader"

try {
  await client.deals.info({ id: "missing" })
} catch (error) {
  if (error instanceof TeamleaderApiError) {
    console.log(error.status, error.errors)
  }
}
```
