import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createAwsS3Api } from "../src/aws-s3-api"

const credentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
}

describe("createAwsS3Api", () => {
  test("uses the configured AWS retry policy for replayable requests", async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts += 1
        if (attempts < 3) {
          return new Response(
            "<Error><Code>SlowDown</Code><Message>retry this request</Message></Error>",
            { status: 503, headers: { "content-type": "application/xml" } }
          )
        }
        return new Response(null, { status: 200 })
      },
    })

    try {
      const api = createAwsS3Api({
        bucket: "test-bucket",
        endpoint: server.url.origin,
        region: "us-east-1",
        pathStyle: true,
        retries: 2,
        ...credentials,
      })
      const body = new TextEncoder().encode("retryable")

      await api.putObject({
        key: "uploads/retry/object",
        body,
        contentMd5: createHash("md5").update(body).digest("base64"),
      })

      expect(attempts).toBe(3)
    } finally {
      server.stop(true)
    }
  })

  test("returns ranged GetObject bodies as Web streams without buffering", async () => {
    const receivedRanges: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        receivedRanges.push(request.headers.get("range"))
        return new Response("bc", {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-length": "2",
            "content-range": "bytes 1-2/4",
          },
        })
      },
    })

    try {
      const api = createAwsS3Api({
        bucket: "test-bucket",
        endpoint: server.url.origin,
        region: "us-east-1",
        pathStyle: true,
        retries: 0,
        ...credentials,
      })

      const stream = await api.getObject({
        key: "objects/value",
        range: { start: 1, endInclusive: 2 },
      })

      expect(receivedRanges).toEqual(["bytes=1-2"])
      expect(await new Response(stream).text()).toBe("bc")
    } finally {
      server.stop(true)
    }
  })

  test("encodes CopyObject sources without losing key path separators", async () => {
    const receivedSources: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        receivedSources.push(request.headers.get("x-amz-copy-source"))
        return new Response(
          '<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-07-18T00:00:00Z</LastModified></CopyObjectResult>',
          { status: 200, headers: { "content-type": "application/xml" } }
        )
      },
    })

    try {
      const api = createAwsS3Api({
        bucket: "test-bucket",
        endpoint: server.url.origin,
        region: "us-east-1",
        pathStyle: true,
        retries: 0,
        ...credentials,
      })

      await api.copyObject("uploads/a b+c/object", "blobs/sha256/value")

      expect(receivedSources).toEqual(["/test-bucket/uploads/a%20b%2Bc/object"])
    } finally {
      server.stop(true)
    }
  })

  test("presigns direct uploads with required integrity and metadata headers", async () => {
    const api = createAwsS3Api({
      bucket: "test-bucket",
      endpoint: "https://storage.example.com",
      region: "us-east-1",
      pathStyle: true,
      retries: 3,
      acl: "bucket-owner-full-control",
      sessionToken: "session-token",
      ...credentials,
    })

    const signed = await api.presignPutObject({
      key: "uploads/direct/object",
      checksumSha256: "Zm9v",
      expiresInSeconds: 60,
      mediaType: "text/plain",
    })
    const url = new URL(signed.url)

    expect(url.pathname).toBe("/test-bucket/uploads/direct/object")
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("session-token")
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual([
      "content-type",
      "host",
      "x-amz-acl",
      "x-amz-checksum-sha256",
    ])
    expect(signed.headers).toEqual({
      "content-type": "text/plain",
      "x-amz-acl": "bucket-owner-full-control",
      "x-amz-checksum-sha256": "Zm9v",
    })
  })

  test("rejects incomplete explicit credentials", () => {
    expect(() =>
      createAwsS3Api({
        bucket: "test-bucket",
        region: "us-east-1",
        pathStyle: false,
        retries: 3,
        accessKeyId: "incomplete",
      })
    ).toThrow("require both accessKeyId and secretAccessKey")
  })

  test("rejects bucket-only ACLs before sending object requests", () => {
    expect(() =>
      createAwsS3Api({
        bucket: "test-bucket",
        region: "us-east-1",
        pathStyle: false,
        retries: 3,
        acl: "log-delivery-write",
        ...credentials,
      })
    ).toThrow("only valid for buckets")
  })
})
