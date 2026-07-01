import { describe, expect, test } from "bun:test"
import { encodeRfc3986, encodeS3Path, presignS3Url, s3ObjectUrl } from "../src/sigv4"

// Known-answer vector from the AWS docs "Signature Calculation for Presigned URL"
// example (GET examplebucket/test.txt, 86400s expiry, 2013-05-24T00:00:00Z). The
// endpoint is set so the signed host matches the example's examplebucket.s3.amazonaws.com.
const AWS_EXAMPLE = {
  method: "GET",
  key: "test.txt",
  headers: {},
  expiresInSeconds: 86400,
  bucket: "examplebucket",
  region: "us-east-1",
  endpoint: "https://s3.amazonaws.com",
  pathStyle: false,
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  now: new Date("2013-05-24T00:00:00.000Z"),
} as const

describe("presignS3Url", () => {
  test("matches the AWS documented presigned-URL known-answer vector", () => {
    const parsed = new URL(presignS3Url(AWS_EXAMPLE))

    expect(parsed.host).toBe("examplebucket.s3.amazonaws.com")
    expect(parsed.pathname).toBe("/test.txt")
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
    )
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z")
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("86400")
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    // Verified independently against the AWS-documented canonical request for this example.
    expect(parsed.searchParams.get("X-Amz-Signature")).toBe(
      "3ed0be64024db54d5574a27da223529635c383f911f80e636f0ccc13890053d2"
    )
  })

  test("signs custom headers and a session token into the request", () => {
    const url = new URL(
      presignS3Url({
        ...AWS_EXAMPLE,
        method: "PUT",
        headers: { "x-amz-checksum-sha256": "Zm9v" },
        sessionToken: "session-token",
      })
    )

    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host;x-amz-checksum-sha256")
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("session-token")
  })

  test("is deterministic for identical inputs", () => {
    expect(presignS3Url(AWS_EXAMPLE)).toBe(presignS3Url(AWS_EXAMPLE))
  })
})

describe("s3ObjectUrl", () => {
  test("builds virtual-hosted-style URLs without an endpoint", () => {
    const url = s3ObjectUrl({
      key: "sixb/blobs/sha256/abc",
      bucket: "company-lake",
      region: "eu-west-1",
      pathStyle: false,
    })
    expect(url.toString()).toBe(
      "https://company-lake.s3.eu-west-1.amazonaws.com/sixb/blobs/sha256/abc"
    )
  })

  test("builds path-style URLs for custom endpoints", () => {
    const url = s3ObjectUrl({
      key: "blobs/sha256/abc",
      bucket: "sixb",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      pathStyle: true,
    })
    expect(url.toString()).toBe("http://127.0.0.1:9000/sixb/blobs/sha256/abc")
  })
})

describe("path encoding", () => {
  test("encodes RFC 3986 reserved characters and preserves path separators", () => {
    expect(encodeRfc3986("a b+c")).toBe("a%20b%2Bc")
    expect(encodeRfc3986("(x)")).toBe("%28x%29")
    expect(encodeS3Path("dir/a b/c.txt")).toBe("dir/a%20b/c.txt")
  })
})
