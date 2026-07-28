import { LocalBlobStorage } from "@sixb/blob-local"
import { S3BlobStorage } from "@sixb/blob-s3"
import { RedisBroker } from "@sixb/broker-redis"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { BullMqQueues } from "@sixb/queues-bullmq"
import { SqliteStorage } from "@sixb/sqlite"

const projectId = "sixb-app"
const isProduction = process.env.NODE_ENV === "production"

const databaseUrl = isProduction
  ? requiredEnv("DATABASE_URL")
  : "postgres://sixb:sixb@localhost:5432/sixb"
const postgres = new URL(databaseUrl)
const redisUrl = isProduction ? requiredEnv("REDIS_URL") : "redis://localhost:6379"
const postgresSchema = process.env.POSTGRES_SCHEMA ?? "sixb"
const bucket = isProduction ? requiredEnv("S3_BUCKET") : "sixb"
const region = process.env.S3_REGION ?? "us-east-1"
const endpoint = process.env.S3_ENDPOINT
const s3Endpoint = endpoint ? new URL(endpoint) : undefined
const accessKeyId = process.env.S3_ACCESS_KEY_ID
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY

if (isProduction && Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
  throw new Error("[sixb-app] S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together.")
}

export const sixb = createSixb({
  id: projectId,
  broker: isProduction ? new RedisBroker({ connection: { url: redisUrl } }) : new InMemoryBroker(),
  storage: isProduction
    ? new PostgresStorage({ connectionString: databaseUrl, schemaName: postgresSchema })
    : new SqliteStorage({ path: ".sixb/sixb.db" }),
  lakeStorage: new DuckLakeStorage({
    duckdb: { path: isProduction ? ":memory:" : ".sixb/duckdb.db" },
    dataPath: isProduction ? `s3://${bucket}/${projectId}/ducklake/` : ".sixb/ducklake/",
    catalog: isProduction
      ? {
          type: "postgres",
          host: postgres.hostname,
          port: postgres.port ? Number(postgres.port) : undefined,
          database: decodeURIComponent(postgres.pathname.replace(/^\//, "")),
          user: postgres.username ? decodeURIComponent(postgres.username) : undefined,
          password: postgres.password ? decodeURIComponent(postgres.password) : undefined,
          metadataSchema: "sixb_lake",
        }
      : {
          type: "sqlite",
          path: ".sixb/ducklake-catalog.db",
        },
    secrets: isProduction
      ? [
          {
            type: "s3",
            provider: accessKeyId ? "config" : "credential_chain",
            keyId: accessKeyId,
            secret: secretAccessKey,
            region,
            endpoint: s3Endpoint?.host,
            urlStyle: s3Endpoint ? "path" : "vhost",
            useSsl: s3Endpoint ? s3Endpoint.protocol === "https:" : true,
            scope: `s3://${bucket}`,
          },
        ]
      : undefined,
  }),
  blobStorage: isProduction
    ? new S3BlobStorage({
        bucket,
        region,
        endpoint,
        accessKeyId,
        secretAccessKey,
        basePath: projectId,
      })
    : new LocalBlobStorage({ basePath: ".sixb/blobs" }),
  queues: isProduction ? new BullMqQueues({ connection: redisUrl }) : new InMemoryQueues(),
})

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`[sixb-app] ${name} is required in production.`)
  return value
}
