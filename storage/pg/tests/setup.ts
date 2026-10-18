import { afterAll, beforeAll } from "bun:test"
import { closeTestDatabases, prepareTestDatabases } from "./helpers"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

// 60s budget for docker compose up + healthcheck. `bun run --workspaces test:e2e`
// runs workspaces in parallel, so on 2-vCPU CI runners several Docker images are
// pulled/started concurrently — a tighter timeout races postgres:17's cold start.
// The migrations run here too, once, rather than inside the first test's timeout.
beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait`.quiet()
  process.env.DATABASE_URL = "postgresql://postgres:test@127.0.0.1:54329/postgres"
  await prepareTestDatabases()
}, 60_000)

afterAll(async () => {
  await closeTestDatabases()
  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
