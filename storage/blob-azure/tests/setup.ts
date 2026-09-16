import { afterAll, beforeAll } from "bun:test"
import { BlobServiceClient } from "@azure/storage-blob"

const composeFile = `${import.meta.dir}/../docker-compose.yml`

beforeAll(async () => {
  await Bun.$`docker compose -f ${composeFile} up -d --wait azurite`.quiet()
  // Keep provisioning outside the provider, as in a deployed application.
  process.env.SIXB_AZURE_CONNECTION_STRING =
    "DefaultEndpointsProtocol=http;AccountName=sixbtest;AccountKey=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=;BlobEndpoint=http://127.0.0.1:49010/sixbtest;"
  process.env.SIXB_AZURE_CONTAINER = "sixb-test"
  const service = BlobServiceClient.fromConnectionString(process.env.SIXB_AZURE_CONNECTION_STRING)
  await service.setProperties({
    cors: [
      {
        allowedOrigins: "http://app.localhost",
        allowedMethods: "PUT",
        allowedHeaders: "content-type,x-ms-blob-type",
        exposedHeaders: "ETag",
        maxAgeInSeconds: 3600,
      },
    ],
  })
  await service.getContainerClient(process.env.SIXB_AZURE_CONTAINER).createIfNotExists()
}, 60_000)

afterAll(async () => {
  await Bun.$`docker compose -f ${composeFile} down -v --remove-orphans`.quiet()
}, 15_000)
