import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait minio`.quiet()
  // Keep bucket creation explicit so the provider tests exercise normal S3 object APIs only.
  await Bun.$`docker compose -f ${composeFile} run --rm minio-mc`.quiet()

  process.env.SIXB_S3_BUCKET = "sixb-test"
  process.env.SIXB_S3_ENDPOINT = "http://127.0.0.1:49000"
  process.env.SIXB_S3_ACCESS_KEY_ID = "minioadmin"
  process.env.SIXB_S3_SECRET_ACCESS_KEY = "minioadmin"
}, 60_000)

afterAll(async () => {
  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
