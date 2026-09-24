import { afterAll, beforeAll } from "bun:test"

const composeFile = `${import.meta.dir}/../docker-compose.yml`
const composeProject = `sixb-blob-s3-${process.pid}`

beforeAll(async () => {
  await Bun.$`docker compose -p ${composeProject} -f ${composeFile} up -d --wait s3`.quiet()

  process.env.SIXB_S3_BUCKET = "sixb-test"
  process.env.SIXB_S3_ENDPOINT = "http://127.0.0.1:49000"
  process.env.SIXB_S3_ACCESS_KEY_ID = "sixb"
  process.env.SIXB_S3_SECRET_ACCESS_KEY = "sixb-secret"
}, 60_000)

afterAll(async () => {
  await Bun.$`docker compose -p ${composeProject} -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
