# Infrastructure providers

Infrastructure providers store your project's data and deliver its events and background jobs. Choose one implementation for each required slot in [Project configuration](../runtime/overview.md).

Open a package's README for installation and configuration options.

## Object storage

The `storage` provider stores objects, relationships, telemetry, authentication state, and execution history.

| Provider | Use for |
| --- | --- |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/sqlite#readme" target="_blank" rel="noopener noreferrer">SQLite</a> | Persistent local development. |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/pg#readme" target="_blank" rel="noopener noreferrer">PostgreSQL</a> | Shared storage for production services. |

## Dataset storage

The `lakeStorage` provider stores datasets and their versions.

| Provider | Use for |
| --- | --- |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/ducklake#readme" target="_blank" rel="noopener noreferrer">DuckLake</a> | A dataset lake with a local or PostgreSQL catalog and local or object storage. |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/lake-local#readme" target="_blank" rel="noopener noreferrer">Local lake</a> | File-based datasets on local disk. |

## File storage

The `blobStorage` provider stores the bytes behind file references.

| Provider | Use for |
| --- | --- |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/blob-local#readme" target="_blank" rel="noopener noreferrer">Local files</a> | Files on your development machine. |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/blob-s3#readme" target="_blank" rel="noopener noreferrer">S3</a> | Shared files in S3 or a compatible service. |
| <a href="https://github.com/sixb-ai/sixb/tree/main/storage/blob-azure#readme" target="_blank" rel="noopener noreferrer">Azure Blob Storage</a> | Shared files in Azure. |

## Events and jobs

The `broker` delivers events. The `queues` provider distributes jobs to workers. They serve different purposes even when both use Redis.

| Slot | Provider |
| --- | --- |
| `broker` | <a href="https://github.com/sixb-ai/sixb/tree/main/broker/redis#readme" target="_blank" rel="noopener noreferrer">Redis Streams</a> |
| `broker` | <a href="https://github.com/sixb-ai/sixb/tree/main/broker/nats#readme" target="_blank" rel="noopener noreferrer">NATS JetStream</a> |
| `queues` | <a href="https://github.com/sixb-ai/sixb/tree/main/queues/bullmq#readme" target="_blank" rel="noopener noreferrer">BullMQ</a> |

For local development and tests, `@sixb/core` includes `InMemoryStorage`, `InMemoryLakeStorage`, `InMemoryBlobStorage`, `InMemoryBroker`, and `InMemoryQueues`. Their state is lost when the process stops and is not shared with other processes.

## Choose a production setup

A typical setup uses PostgreSQL for objects, DuckLake with a PostgreSQL catalog and shared object storage for datasets, S3 for files, and Redis for both events and BullMQ jobs.

All services must use the same providers and project ID. Separate dataset and file storage locations so their contents can be managed independently. See [Deployment](../deployment/overview.md) for building and starting the services.
