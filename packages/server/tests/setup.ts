import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

// Allow cold image startup when workspace E2E suites run concurrently.
beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait`.quiet()
  await Bun.$`docker compose -f ${composeFile} exec -T postgres psql -U postgres -d postgres -c 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public'`.quiet()
  process.env.DATABASE_URL = "postgresql://postgres:test@127.0.0.1:54330/postgres"
}, 60_000)

afterAll(async () => {
  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
