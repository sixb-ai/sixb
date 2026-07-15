import { describe, expect, test } from "bun:test"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { createSixbClient, SixbFileUploadError, uploadFile } from "../src"

const encoder = new TextEncoder()

function createFileUploadClient() {
  const requests: Request[] = []
  const client = createSixbClient({
    baseUrl: "http://sixb.test/api",
    auth: { kind: "cookie", csrfToken: () => "csrf_file_1" },
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request && !init ? input : new Request(input, init)
        requests.push(request)

        return Response.json({
          blobId: "blob_abc",
          digest: "sha256:abc",
          sizeBytes: 11,
          fileName: "report.txt",
          mediaType: "text/plain",
          logicalPath: "reports/report.txt",
        })
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch,
  })

  return { client, requests }
}

function createStagedUploadClient() {
  const requests: Request[] = []
  const client = createSixbClient({
    baseUrl: "http://sixb.test/api",
    auth: { kind: "cookie", csrfToken: () => "csrf_file_1" },
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request && !init ? input : new Request(input, init)
        requests.push(request)

        if (request.url === "http://sixb.test/api/files/uploads") {
          return Response.json(
            {
              strategy: "server",
              uploadId: "upload_1",
              method: "PUT",
              url: "/api/files/uploads/upload_1/content",
              expiresAt: "2026-06-30T20:00:00.000Z",
            },
            { status: 201 }
          )
        }

        if (request.url === "http://sixb.test/api/files/uploads/upload_1/content") {
          return Response.json({ success: true })
        }

        if (request.url === "http://sixb.test/api/files/uploads/upload_1/complete") {
          return Response.json({
            blobId: "blob_staged",
            digest: "sha256:staged",
            sizeBytes: 12,
            fileName: "large.txt",
            mediaType: "text/plain",
            logicalPath: "reports/large.txt",
          })
        }

        return Response.json(
          { error: `Unexpected request ${request.method} ${request.url}` },
          { status: 500 }
        )
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch,
  })

  return { client, requests }
}

function createDirectPutUploadClient() {
  const requests: Request[] = []
  const directRequests: Request[] = []
  const client = createSixbClient({
    baseUrl: "http://sixb.test/api",
    auth: { kind: "cookie", csrfToken: () => "csrf_file_1" },
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request && !init ? input : new Request(input, init)
        requests.push(request)

        if (request.url === "http://sixb.test/api/files/uploads") {
          return Response.json(
            {
              strategy: "direct-put",
              uploadId: "upload_direct",
              method: "PUT",
              url: "https://storage.test/uploads/upload_direct/object",
              headers: { "x-upload": "direct" },
              expiresAt: "2026-06-30T20:00:00.000Z",
            },
            { status: 201 }
          )
        }

        if (request.url === "http://sixb.test/api/files/uploads/upload_direct/complete") {
          return Response.json({
            blobId: "blob_direct",
            digest: "sha256:direct",
            sizeBytes: 12,
            fileName: "large.txt",
            mediaType: "text/plain",
            logicalPath: "reports/large.txt",
          })
        }

        return Response.json(
          { error: `Unexpected request ${request.method} ${request.url}` },
          { status: 500 }
        )
      },
      { preconnect: fetch.preconnect }
    ) satisfies typeof fetch,
  })
  const directFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      directRequests.push(request)
      return new Response(null, { status: 200 })
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch

  return { client, directFetch, directRequests, requests }
}

describe("uploadFile", () => {
  test("uploads a multipart file through the generated files route", async () => {
    const { client, requests } = createFileUploadClient()

    const fileRef = await uploadFile(new Blob(["hello world"], { type: "text/plain" }), {
      client,
      fileName: "report.txt",
      logicalPath: "reports/report.txt",
    })

    expect(fileRef).toEqual({
      blobId: "blob_abc",
      digest: "sha256:abc",
      sizeBytes: 11,
      fileName: "report.txt",
      mediaType: "text/plain",
      logicalPath: "reports/report.txt",
    })

    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe("http://sixb.test/api/files")
    expect(request?.credentials).toBe("include")
    expect(request?.headers.get("x-sixb-csrf")).toBe("csrf_file_1")
    expect(request?.headers.get("content-type")).toContain("multipart/form-data")

    const form = await request?.formData()
    const uploaded = form?.get("file")
    expect(uploaded).toBeInstanceOf(File)
    expect((uploaded as File).name).toBe("report.txt")
    expect((uploaded as File).type).toBe("text/plain;charset=utf-8")
    expect(await (uploaded as File).text()).toBe("hello world")
    expect(form?.get("logicalPath")).toBe("reports/report.txt")
  })

  test("uses staged server upload when the file exceeds the staged threshold", async () => {
    const { client, requests } = createStagedUploadClient()

    const fileRef = await uploadFile(new Blob(["hello staged"], { type: "text/plain" }), {
      client,
      fileName: "large.txt",
      logicalPath: "reports/large.txt",
      stagedUploadThresholdBytes: 0,
    })

    expect(fileRef).toEqual({
      blobId: "blob_staged",
      digest: "sha256:staged",
      sizeBytes: 12,
      fileName: "large.txt",
      mediaType: "text/plain",
      logicalPath: "reports/large.txt",
    })

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "http://sixb.test/api/files/uploads"],
      ["PUT", "http://sixb.test/api/files/uploads/upload_1/content"],
      ["POST", "http://sixb.test/api/files/uploads/upload_1/complete"],
    ])
    const digest = computeBlobDigest(encoder.encode("hello staged"))
    expect(await requests[0]?.json()).toEqual({
      fileName: "large.txt",
      mediaType: "text/plain;charset=utf-8",
      sizeBytes: 12,
      digest,
      logicalPath: "reports/large.txt",
    })
    expect(requests[1]?.headers.get("content-type")).toBe("application/octet-stream")
    expect(await requests[1]?.text()).toBe("hello staged")
    expect(await requests[2]?.json()).toEqual({
      digest,
      sizeBytes: 12,
    })
  })

  test("uses direct-put staged upload when the server returns a direct upload URL", async () => {
    const { client, directFetch, directRequests, requests } = createDirectPutUploadClient()

    const fileRef = await uploadFile(new Blob(["hello direct"], { type: "text/plain" }), {
      client,
      fetch: directFetch,
      fileName: "large.txt",
      logicalPath: "reports/large.txt",
      stagedUploadThresholdBytes: 0,
    })

    expect(fileRef.blobId).toBe("blob_direct")
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "http://sixb.test/api/files/uploads"],
      ["POST", "http://sixb.test/api/files/uploads/upload_direct/complete"],
    ])
    expect(directRequests).toHaveLength(1)
    expect(directRequests[0]?.method).toBe("PUT")
    expect(directRequests[0]?.url).toBe("https://storage.test/uploads/upload_direct/object")
    expect(directRequests[0]?.headers.get("x-upload")).toBe("direct")
    expect(await directRequests[0]?.text()).toBe("hello direct")
    expect(await requests[0]?.json()).toEqual({
      fileName: "large.txt",
      mediaType: "text/plain;charset=utf-8",
      sizeBytes: 12,
      digest: computeBlobDigest(encoder.encode("hello direct")),
      logicalPath: "reports/large.txt",
    })
    expect(await requests[1]?.json()).toEqual({
      digest: computeBlobDigest(encoder.encode("hello direct")),
      sizeBytes: 12,
    })
  })

  test("throws a typed SixbFileUploadError carrying stage and status on a server error", async () => {
    const client = createSixbClient({
      baseUrl: "http://sixb.test/api",
      auth: { kind: "cookie", csrfToken: () => "csrf_file_1" },
      fetch: Object.assign(
        async () => Response.json({ error: "upload rejected" }, { status: 400 }),
        {
          preconnect: fetch.preconnect,
        }
      ) satisfies typeof fetch,
    })

    const error = await uploadFile(new Blob(["x"], { type: "text/plain" }), { client }).catch(
      (thrown) => thrown
    )

    expect(error).toBeInstanceOf(SixbFileUploadError)
    expect((error as SixbFileUploadError).stage).toBe("server-put")
    expect((error as SixbFileUploadError).status).toBe(400)
    expect((error as SixbFileUploadError).aborted).toBe(false)
    expect((error as SixbFileUploadError).message).toContain("upload rejected")
  })

  test("surfaces an aborted upload as an abort-flagged error and cleans up the session", async () => {
    const requests: Request[] = []
    const client = createSixbClient({
      baseUrl: "http://sixb.test/api",
      auth: { kind: "cookie", csrfToken: () => "csrf_file_1" },
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request && !init ? input : new Request(input, init)
          requests.push(request)

          if (request.url === "http://sixb.test/api/files/uploads") {
            return Response.json(
              {
                strategy: "server",
                uploadId: "upload_1",
                method: "PUT",
                url: "/api/files/uploads/upload_1/content",
                expiresAt: "2026-06-30T20:00:00.000Z",
              },
              { status: 201 }
            )
          }

          if (request.url === "http://sixb.test/api/files/uploads/upload_1/content") {
            throw new DOMException("The operation was aborted.", "AbortError")
          }

          if (request.url === "http://sixb.test/api/files/uploads/upload_1/abort") {
            return Response.json({ success: true })
          }

          return Response.json({ error: "unexpected" }, { status: 500 })
        },
        { preconnect: fetch.preconnect }
      ) satisfies typeof fetch,
    })

    const controller = new AbortController()
    const error = await uploadFile(new Blob(["hello staged"], { type: "text/plain" }), {
      client,
      signal: controller.signal,
      stagedUploadThresholdBytes: 0,
    }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(SixbFileUploadError)
    expect((error as SixbFileUploadError).aborted).toBe(true)
    expect((error as SixbFileUploadError).stage).toBe("abort")

    // The staged session is released via a detached cleanup abort.
    const abortRequest = requests.find(
      (request) => request.url === "http://sixb.test/api/files/uploads/upload_1/abort"
    )
    expect(abortRequest?.method).toBe("POST")
  })
})
