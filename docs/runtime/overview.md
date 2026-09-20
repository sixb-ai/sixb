# Runtime

Configure your project in `sixb.config.ts`: choose where data lives, how background work runs,
and which services your app uses. The Sixb CLI starts those services for you.

## Configure your project

This example uses PostgreSQL for objects, DuckLake for datasets, S3 for files, and Redis for
events and background jobs. Set the environment variables before starting the project.
For local development, the [starter](../README.md) already includes a working configuration.

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { PostgresStorage } from "@sixb/pg"
import { DuckLakeStorage } from "@sixb/ducklake"
import { S3BlobStorage } from "@sixb/blob-s3"
import { RedisBroker } from "@sixb/broker-redis"
import { BullMqQueues } from "@sixb/queues-bullmq"

export const sixb = createSixb({
  id: "my-app",
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL! }),
  lakeStorage: new DuckLakeStorage({
    catalog: {
      type: "postgres",
      host: process.env.LAKE_DB_HOST!,
      database: process.env.LAKE_DB_NAME!,
      user: process.env.LAKE_DB_USER!,
      password: process.env.LAKE_DB_PASSWORD!,
      sslMode: "require",
    },
    dataPath: process.env.LAKE_DATA_PATH!, // s3://my-bucket/datasets
    secrets: [{ type: "s3", provider: "credential_chain", region: process.env.AWS_REGION! }],
  }),
  blobStorage: new S3BlobStorage({
    bucket: process.env.BLOB_BUCKET!,
    region: process.env.AWS_REGION!,
    basePath: "sixb",
  }),
  broker: new RedisBroker({ connection: { url: process.env.REDIS_URL! } }),
  queues: new BullMqQueues({ connection: process.env.REDIS_URL! }),
})
```

Install the provider packages you use. Configure S3 access for both
[DuckLake](https://github.com/sixb-ai/sixb/tree/main/storage/ducklake) and the blob provider.
All production processes must share the same configuration and credentials.
`createSixb()` is asynchronous; the CLI awaits the exported value.

## Required providers

| Option | Type | Purpose |
| --- | --- | --- |
| `storage` | `Storage` | Objects, relationships, telemetry, and run history |
| `lakeStorage` | `LakeStorage` | Datasets used by syncs and pipelines |
| `blobStorage` | `BlobStorage` | Files and attachments |
| `broker` | `Broker` | Events and subscriptions |
| `queues` | `Queues` | Background work |

See [Infrastructure](../infrastructure/overview.md) to compare providers.

## Optional configuration

| Option | Use it to |
| --- | --- |
| `id` | Name the project |
| `auth` | Configure [sign-in and sessions](../auth/authentication.md) |
| `models` | Configure [language models](../models/configuration.md) |
| `sandboxes` | Choose where [agent commands run](../sandboxes/overview.md) |
| `tools` | Add [custom agent tools](../models/tools-and-authorization.md#custom-tools) |
| `logger`, `observability` | Configure [log output and capture](../logging/overview.md) |
| `onError` | Receive [failure notifications](error-codes.md#failure-notifications) |
| `connectorConnections` | Protect [OAuth credentials](../connectors/authentication.md#protect-oauth-credentials) |
| `ontologyMaintenance` | Adjust [retention](../infrastructure/overview.md#retention) |
| `projectRoot` | Change the project directory; defaults to the current working directory |

## Start the project

```bash
bun sixb dev
```

Sixb validates your definitions before starting. Missing references, duplicate IDs, or invalid
properties stop startup with an error. Folder conventions are covered in
[Project structure](../fundamentals/project-structure.md).

Inside a workflow or webhook, use the `sixb` argument provided to your handler to read objects or
request actions. Other primitives have their own typed contexts. The configuration export is for
starting the project; use the handler APIs for application operations.

## Next

- [Runtime errors](error-codes.md) — handle errors and monitor failed runs
- [Infrastructure](../infrastructure/overview.md) — choose providers
- [Deployment](../deployment/overview.md) — run production services

For model calls from actions and workflows, use [`sixb.models.language.generate()`](../models/generation.md).
