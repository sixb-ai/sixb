import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

let composeStarted = false

beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait postgres minio`.quiet()
  composeStarted = true
  await Bun.$`docker compose -f ${composeFile} run --rm createbuckets`.quiet()

  process.env.PARIO_DUCKLAKE_POSTGRES_HOST = "127.0.0.1"
  process.env.PARIO_DUCKLAKE_POSTGRES_PORT = "54331"
  process.env.PARIO_DUCKLAKE_POSTGRES_DATABASE = "postgres"
  process.env.PARIO_DUCKLAKE_POSTGRES_USER = "postgres"
  process.env.PARIO_DUCKLAKE_POSTGRES_PASSWORD = "test"
  process.env.PARIO_DUCKLAKE_S3_ENDPOINT = "127.0.0.1:19000"
  process.env.PARIO_DUCKLAKE_S3_BUCKET = "pario-ducklake"
  process.env.PARIO_DUCKLAKE_S3_KEY_ID = "pario"
  process.env.PARIO_DUCKLAKE_S3_SECRET = "pario-secret"
}, 90_000)

afterAll(async () => {
  if (!composeStarted) {
    return
  }

  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 30_000)
