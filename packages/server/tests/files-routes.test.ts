import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SIMPLE_FILE_UPLOAD_BYTES,
  defineObjectType,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import {
  type AbortBlobUploadInput,
  type BlobUploadSession,
  blobIdFromDigest,
  type CompleteBlobUploadInput,
  type CreateBlobUploadInput,
  computeBlobDigest,
  type DirectUploadBlobStorage,
  type SignBlobUploadPartInput,
  type SignedBlobUploadPart,
} from "@sixb/core/blob-storage/server"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES } from "../src/routes/files"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("attachment", "fileRef"),
  ],
})

class TestDirectBlobStorage extends InMemoryBlobStorage implements DirectUploadBlobStorage {
  createInput: CreateBlobUploadInput | undefined
  completeInput: CompleteBlobUploadInput | undefined
  abortInput: AbortBlobUploadInput | undefined

  async createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession> {
    this.createInput = input
    return {
      strategy: "direct-put",
      uploadId: input.uploadId,
      method: "PUT",
      url: "https://storage.test/uploads/object",
      headers: { "x-upload": "direct" },
      expiresAt: input.expiresAt,
      stagingKey: `staging/${input.uploadId}`,
    }
  }

  async signUploadPart(_input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart> {
    throw new Error("Multipart is not used in this test.")
  }

  async completeUpload(input: CompleteBlobUploadInput): Promise<FileRef> {
    if (!input.expectedDigest || input.expectedSizeBytes === undefined) {
      throw new Error("Expected digest and size.")
    }

    this.completeInput = input
    return {
      blobId: blobIdFromDigest(input.expectedDigest),
      digest: input.expectedDigest,
      sizeBytes: input.expectedSizeBytes,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.logicalPath === undefined ? {} : { logicalPath: input.logicalPath }),
    }
  }

  async abortUpload(input: AbortBlobUploadInput): Promise<void> {
    this.abortInput = input
  }
}

function createFilesApi(blobStorage = new InMemoryBlobStorage()) {
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Document],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
  })

  return {
    app: createSixbApi(new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })),
    blobStorage,
  }
}

function uploadRequest(form: FormData): Request {
  return new Request("http://localhost/api/files", {
    method: "POST",
    body: form,
  })
}

function oversizedUploadRequest(): Request {
  return new Request("http://localhost/api/files", {
    method: "POST",
    headers: {
      "content-length": String(DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES + 1),
      "content-type": "multipart/form-data; boundary=sixb-test",
    },
    body: "--sixb-test\r\ninvalid multipart body",
  })
}

function jsonRequest(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function stagedContentRequest(uploadId: string, body: BodyInit): Request {
  return new Request(`http://localhost/api/files/uploads/${uploadId}/content`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  })
}

describe("file routes", () => {
  test("uploads a multipart file and returns a FileRef", async () => {
    const { app, blobStorage } = createFilesApi()
    const form = new FormData()
    form.set("file", new File(["hello file"], "hello.txt", { type: "text/plain" }))
    form.set("logicalPath", "docs/hello.txt")

    const response = await app.fetch(uploadRequest(form))
    expect(response.status).toBe(200)

    const fileRef = (await response.json()) as FileRef
    expect(fileRef.blobId).toMatch(/^blob_[a-f0-9]{64}$/)
    expect(fileRef.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(fileRef).toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: 10,
      fileName: "hello.txt",
      mediaType: "text/plain;charset=utf-8",
      logicalPath: "docs/hello.txt",
    })
    expect(fileRef.blobId).toBe(`blob_${fileRef.digest.slice("sha256:".length)}`)

    const stored = await blobStorage.open(fileRef.blobId)
    expect(await new Response(stored).text()).toBe("hello file")
  })

  test("rejects uploads without a file field", async () => {
    const { app } = createFilesApi()
    const form = new FormData()
    form.set("logicalPath", "docs/missing.txt")

    const response = await app.fetch(uploadRequest(form))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Expected multipart field 'file' to be a file.",
    })
  })

  test("rejects uploads over the configured route limit", async () => {
    const { app } = createFilesApi()
    const form = new FormData()
    form.set("file", new File([new Uint8Array(DEFAULT_SIMPLE_FILE_UPLOAD_BYTES + 1)], "large.bin"))

    const response = await app.fetch(uploadRequest(form))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: `File upload exceeds the ${DEFAULT_SIMPLE_FILE_UPLOAD_BYTES} byte limit.`,
    })
  })

  test("rejects obviously oversized upload requests before parsing multipart", async () => {
    const { app } = createFilesApi()

    const response = await app.fetch(oversizedUploadRequest())

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: `File upload request exceeds the ${DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES} byte limit.`,
    })
  })

  test("creates a server staged upload for providers without direct upload support", async () => {
    const { app } = createFilesApi()

    const response = await app.fetch(
      jsonRequest("/api/files/uploads", {
        fileName: "large.txt",
        mediaType: "text/plain",
        sizeBytes: 11,
        logicalPath: "docs/large.txt",
      })
    )

    expect(response.status).toBe(201)
    const upload = (await response.json()) as {
      strategy: string
      uploadId: string
      method: string
      url: string
      expiresAt: string
    }
    expect(upload.strategy).toBe("server")
    expect(upload.uploadId).toMatch(/^upload_[a-f0-9]{32}$/)
    expect(upload.method).toBe("PUT")
    expect(upload.url).toBe(`/api/files/uploads/${upload.uploadId}/content`)
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  test("uploads staged server content and completes to a FileRef", async () => {
    const { app, blobStorage } = createFilesApi()
    const digest = computeBlobDigest(new TextEncoder().encode("hello large"))
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", {
        fileName: "large.txt",
        mediaType: "text/plain",
        sizeBytes: 11,
        digest,
        logicalPath: "docs/large.txt",
      })
    )
    const upload = (await createResponse.json()) as { uploadId: string }

    const contentResponse = await app.fetch(stagedContentRequest(upload.uploadId, "hello large"))
    expect(contentResponse.status).toBe(200)
    expect(await contentResponse.json()).toEqual({ success: true })

    const completeResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, {})
    )
    expect(completeResponse.status).toBe(200)
    const fileRef = (await completeResponse.json()) as FileRef
    expect(fileRef).toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: 11,
      fileName: "large.txt",
      mediaType: "text/plain",
      logicalPath: "docs/large.txt",
    })

    const stored = await blobStorage.open(fileRef.blobId)
    expect(await new Response(stored).text()).toBe("hello large")
  })

  test("creates and completes a direct staged upload with expected digest and size", async () => {
    const blobStorage = new TestDirectBlobStorage()
    const { app } = createFilesApi(blobStorage)
    const digest = computeBlobDigest(new TextEncoder().encode("hello direct"))

    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", {
        fileName: "direct.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        digest,
        logicalPath: "docs/direct.txt",
      })
    )
    expect(createResponse.status).toBe(201)
    const upload = (await createResponse.json()) as {
      strategy: string
      uploadId: string
      headers: Record<string, string>
    }
    expect(upload.strategy).toBe("direct-put")
    expect(upload.headers).toEqual({ "x-upload": "direct" })
    expect(blobStorage.createInput).toMatchObject({
      uploadId: upload.uploadId,
      sizeBytes: 12,
      expectedDigest: digest,
    })

    const completeResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, {
        digest,
        sizeBytes: 12,
      })
    )
    expect(completeResponse.status).toBe(200)
    expect(await completeResponse.json()).toEqual({
      blobId: blobIdFromDigest(digest),
      digest,
      sizeBytes: 12,
      fileName: "direct.txt",
      mediaType: "text/plain",
      logicalPath: "docs/direct.txt",
    })
    expect(blobStorage.completeInput).toMatchObject({
      uploadId: upload.uploadId,
      stagingKey: `staging/${upload.uploadId}`,
      expectedSizeBytes: 12,
      expectedDigest: digest,
    })
  })

  test("rejects completion before staged server content is uploaded", async () => {
    const { app } = createFilesApi()
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", {
        fileName: "empty.txt",
      })
    )
    const upload = (await createResponse.json()) as { uploadId: string }

    const completeResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, {})
    )

    expect(completeResponse.status).toBe(400)
    expect(await completeResponse.json()).toEqual({
      error: "Upload content has not been received.",
    })
  })

  test("aborts a staged server upload", async () => {
    const { app } = createFilesApi()
    const createResponse = await app.fetch(jsonRequest("/api/files/uploads", {}))
    const upload = (await createResponse.json()) as { uploadId: string }

    const abortResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/abort`)
    )
    expect(abortResponse.status).toBe(200)
    expect(await abortResponse.json()).toEqual({ success: true })

    const completeResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, {})
    )
    expect(completeResponse.status).toBe(409)
    expect(await completeResponse.json()).toEqual({
      error: "File upload session is already aborted.",
    })
  })

  test("rejects staged server content that does not match the declared size", async () => {
    const { app, blobStorage } = createFilesApi()
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", {
        sizeBytes: 12,
      })
    )
    const upload = (await createResponse.json()) as { uploadId: string }

    const contentResponse = await app.fetch(stagedContentRequest(upload.uploadId, "hello large"))

    expect(contentResponse.status).toBe(400)
    expect(await contentResponse.json()).toEqual({
      error: "File upload size mismatch: expected 12 bytes, received 11.",
    })

    const digest = computeBlobDigest(new TextEncoder().encode("hello large"))
    expect(await blobStorage.stat(blobIdFromDigest(digest))).toBeNull()
  })

  test("rejects staged server content that does not match the declared digest", async () => {
    const { app, blobStorage } = createFilesApi()
    const expectedDigest = computeBlobDigest(new TextEncoder().encode("different"))
    const actualDigest = computeBlobDigest(new TextEncoder().encode("hello large"))
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", {
        sizeBytes: 11,
        digest: expectedDigest,
      })
    )
    const upload = (await createResponse.json()) as { uploadId: string }

    const contentResponse = await app.fetch(stagedContentRequest(upload.uploadId, "hello large"))

    expect(contentResponse.status).toBe(400)
    expect(await contentResponse.json()).toEqual({
      error: `File upload digest mismatch: expected ${expectedDigest}, received ${actualDigest}.`,
    })
    expect(await blobStorage.stat(blobIdFromDigest(actualDigest))).toBeNull()
  })

  test("returns the cached fileRef when completion is retried", async () => {
    const { app } = createFilesApi()
    const digest = computeBlobDigest(new TextEncoder().encode("hello large"))
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", { fileName: "large.txt", sizeBytes: 11, digest })
    )
    const upload = (await createResponse.json()) as { uploadId: string }
    await app.fetch(stagedContentRequest(upload.uploadId, "hello large"))

    const first = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, { digest, sizeBytes: 11 })
    )
    expect(first.status).toBe(200)
    const firstRef = (await first.json()) as FileRef

    const second = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, { digest, sizeBytes: 11 })
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(firstRef)
  })

  test("rejects aborting an already completed upload", async () => {
    const { app } = createFilesApi()
    const digest = computeBlobDigest(new TextEncoder().encode("hello large"))
    const createResponse = await app.fetch(
      jsonRequest("/api/files/uploads", { sizeBytes: 11, digest })
    )
    const upload = (await createResponse.json()) as { uploadId: string }
    await app.fetch(stagedContentRequest(upload.uploadId, "hello large"))
    await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/complete`, { digest, sizeBytes: 11 })
    )

    const abortResponse = await app.fetch(
      jsonRequest(`/api/files/uploads/${upload.uploadId}/abort`)
    )
    expect(abortResponse.status).toBe(409)
    expect(await abortResponse.json()).toEqual({
      error: "File upload session is already completed.",
    })
  })

  test("treats aborting an already aborted upload as a no-op", async () => {
    const { app } = createFilesApi()
    const createResponse = await app.fetch(jsonRequest("/api/files/uploads", {}))
    const upload = (await createResponse.json()) as { uploadId: string }

    const first = await app.fetch(jsonRequest(`/api/files/uploads/${upload.uploadId}/abort`))
    expect(first.status).toBe(200)

    const second = await app.fetch(jsonRequest(`/api/files/uploads/${upload.uploadId}/abort`))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ success: true })
  })

  test("rejects staged content for a terminal session", async () => {
    const { app } = createFilesApi()
    const createResponse = await app.fetch(jsonRequest("/api/files/uploads", {}))
    const upload = (await createResponse.json()) as { uploadId: string }
    await app.fetch(jsonRequest(`/api/files/uploads/${upload.uploadId}/abort`))

    const contentResponse = await app.fetch(stagedContentRequest(upload.uploadId, "late content"))
    expect(contentResponse.status).toBe(409)
    expect(await contentResponse.json()).toEqual({
      error: "File upload session is already aborted.",
    })
  })

  test("rejects staged content that exceeds the upload size limit", async () => {
    const { app } = createFilesApi()
    const createResponse = await app.fetch(jsonRequest("/api/files/uploads", {}))
    const upload = (await createResponse.json()) as { uploadId: string }

    const response = await app.fetch(
      new Request(`http://localhost/api/files/uploads/${upload.uploadId}/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(DEFAULT_SIMPLE_FILE_UPLOAD_BYTES + 1),
        },
        body: "small body",
      })
    )
    expect(response.status).toBe(413)
  })
})
