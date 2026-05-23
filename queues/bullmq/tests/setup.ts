import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

// 60s budget for docker compose up + healthcheck. `bun run --workspaces test:e2e`
// runs workspaces in parallel, so on 2-vCPU CI runners several Docker images are
// pulled/started concurrently — keep the margin generous to avoid flakes.
beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait`.quiet()
  process.env.SIXB_REDIS_URL = "redis://127.0.0.1:46379"
}, 60_000)

afterAll(async () => {
  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
