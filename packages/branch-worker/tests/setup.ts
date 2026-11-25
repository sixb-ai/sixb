import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/docker-compose.yml`
const project = ["--project-name", "sixb-branch-worker-e2e"]

beforeAll(async () => {
  await Bun.$`docker compose ${project} -f ${composeFile} up -d --wait`.quiet()
  process.env.DATABASE_URL = "postgresql://postgres:test@127.0.0.1:54335/postgres"
  process.env.REDIS_URL = "redis://127.0.0.1:46395"
}, 120_000)

afterAll(async () => {
  await Bun.$`docker compose ${project} -f ${composeFile} down -v --remove-orphans`.quiet()
}, 30_000)
