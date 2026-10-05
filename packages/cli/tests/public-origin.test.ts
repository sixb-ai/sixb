import { afterEach, describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { recordApiPublicOrigin } from "../src/lib/public-origin"

const previousOrigin = process.env.SIXB_API_PUBLIC_ORIGIN

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.SIXB_API_PUBLIC_ORIGIN
  else process.env.SIXB_API_PUBLIC_ORIGIN = previousOrigin
})

async function downloadUrlFrom(configure: (host: SixbHost) => void): Promise<string> {
  const host = new SixbHost({
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  configure(host)
  const sixb = createTestSixb(host)
  const file = await sixb.blobs.put({ body: new Uint8Array([1, 2, 3]) })
  return (await sixb.blobs.createDownloadUrl(file)).url
}

describe("recordApiPublicOrigin", () => {
  test("gives a worker's download URLs the flag's origin over the environment's", async () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://env.example.com"

    expect(
      await downloadUrlFrom((host) => recordApiPublicOrigin(host, "https://flag.example.com"))
    ).toStartWith("https://flag.example.com/api/files/downloads/")
    expect(await downloadUrlFrom((host) => recordApiPublicOrigin(host, undefined))).toStartWith(
      "https://env.example.com/api/files/downloads/"
    )
  })

  test("leaves the origin unknown when neither is set", async () => {
    delete process.env.SIXB_API_PUBLIC_ORIGIN

    await expect(downloadUrlFrom((host) => recordApiPublicOrigin(host, undefined))).rejects.toThrow(
      "SIXB_API_PUBLIC_ORIGIN"
    )
  })

  test("refuses a value that is not an origin", async () => {
    await expect(
      downloadUrlFrom((host) => recordApiPublicOrigin(host, "https://api.example.com/v1"))
    ).rejects.toThrow("must be an origin")
  })
})
