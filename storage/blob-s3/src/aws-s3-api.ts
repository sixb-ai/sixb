import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type ObjectCannedACL,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { BlobStorageError } from "@sixb/core/blob-storage/server"
import type { S3UploadApi } from "./s3-multipart-upload"
import type { S3BlobStorageAcl, S3BlobStorageOptions } from "./types"

interface S3ObjectHead {
  readonly sizeBytes: number
  readonly checksumSha256: string | undefined
}

interface S3GetObjectInput {
  readonly key: string
  readonly range?: {
    readonly start: number
    readonly endInclusive: number
  }
}

interface S3HeadObjectInput {
  readonly key: string
  readonly checksumMode?: boolean
}

interface S3PresignPutObjectInput {
  readonly key: string
  readonly checksumSha256: string
  readonly expiresInSeconds: number
  readonly mediaType?: string
}

interface S3PresignedPutObject {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface S3Api extends S3UploadApi {
  getObject(input: S3GetObjectInput): Promise<ReadableStream<Uint8Array>>
  headObject(input: S3HeadObjectInput): Promise<S3ObjectHead>
  copyObject(sourceKey: string, destinationKey: string): Promise<void>
  deleteObject(key: string): Promise<void>
  presignPutObject(input: S3PresignPutObjectInput): Promise<S3PresignedPutObject>
}

interface AwsS3ApiOptions
  extends Pick<
    S3BlobStorageOptions,
    | "bucket"
    | "region"
    | "endpoint"
    | "accessKeyId"
    | "secretAccessKey"
    | "sessionToken"
    | "acl"
    | "pathStyle"
  > {
  readonly retries: number
}

export function createAwsS3Api(options: AwsS3ApiOptions): S3Api {
  const bucket = options.bucket
  const acl = objectAcl(options.acl)
  const client = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.pathStyle,
    credentials: explicitCredentials(options),
    // Parts are fixed Uint8Array values, so every request body is replayable by the SDK.
    maxAttempts: options.retries + 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })

  const requireBucket = () => {
    if (!bucket) {
      throw new BlobStorageError("[BlobS3] S3 operations require a bucket configuration.")
    }
    return bucket
  }

  return {
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: requireBucket(),
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentMD5: input.contentMd5,
          ContentType: input.mediaType,
          ACL: acl,
        }),
        { abortSignal: input.signal }
      )
    },

    async createMultipartUpload(input) {
      const response = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: requireBucket(),
          Key: input.key,
          ContentType: input.mediaType,
          ACL: acl,
        }),
        { abortSignal: input.signal }
      )
      if (!response.UploadId) {
        throw new BlobStorageError("[BlobS3] S3 did not return a multipart upload id.")
      }
      return response.UploadId
    },

    async uploadPart(input) {
      const response = await client.send(
        new UploadPartCommand({
          Bucket: requireBucket(),
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentMD5: input.contentMd5,
        }),
        { abortSignal: input.signal }
      )
      if (!response.ETag) {
        throw new BlobStorageError(
          `[BlobS3] S3 did not return an ETag for multipart part ${input.partNumber}.`
        )
      }
      return response.ETag
    },

    async completeMultipartUpload(input) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: requireBucket(),
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
        { abortSignal: input.signal }
      )
    },

    async abortMultipartUpload(input) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: requireBucket(),
          Key: input.key,
          UploadId: input.uploadId,
        })
      )
    },

    async getObject(input) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: requireBucket(),
          Key: input.key,
          Range:
            input.range === undefined
              ? undefined
              : `bytes=${input.range.start}-${input.range.endInclusive}`,
        })
      )
      if (!response.Body) {
        throw new BlobStorageError(`[BlobS3] S3 returned no body for object '${input.key}'.`)
      }
      return response.Body.transformToWebStream() as ReadableStream<Uint8Array>
    },

    async headObject(input) {
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: requireBucket(),
          Key: input.key,
          ChecksumMode: input.checksumMode ? "ENABLED" : undefined,
        })
      )
      return {
        sizeBytes: response.ContentLength ?? Number.NaN,
        checksumSha256: response.ChecksumSHA256,
      }
    },

    async copyObject(sourceKey, destinationKey) {
      const configuredBucket = requireBucket()
      await client.send(
        new CopyObjectCommand({
          Bucket: configuredBucket,
          Key: destinationKey,
          CopySource: copySource(configuredBucket, sourceKey),
          ACL: acl,
        })
      )
    },

    async deleteObject(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: requireBucket(),
          Key: key,
        })
      )
    },

    async presignPutObject(input) {
      const headers: Record<string, string> = {
        "x-amz-checksum-sha256": input.checksumSha256,
        ...(input.mediaType === undefined ? {} : { "content-type": input.mediaType }),
        ...(acl === undefined ? {} : { "x-amz-acl": acl }),
      }
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: requireBucket(),
          Key: input.key,
          ChecksumSHA256: input.checksumSha256,
          ContentType: input.mediaType,
          ACL: acl,
        }),
        {
          expiresIn: input.expiresInSeconds,
          // Keep integrity and ACL values as required request headers instead of query parameters.
          unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-acl"]),
          ...(input.mediaType === undefined ? {} : { signableHeaders: new Set(["content-type"]) }),
        }
      )
      return { url, headers }
    },
  }
}

function explicitCredentials(
  options: Pick<S3BlobStorageOptions, "accessKeyId" | "secretAccessKey" | "sessionToken">
):
  | {
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken?: string
    }
  | undefined {
  const hasAccessKey = options.accessKeyId !== undefined
  const hasSecretKey = options.secretAccessKey !== undefined
  if (hasAccessKey !== hasSecretKey || (options.sessionToken !== undefined && !hasAccessKey)) {
    throw new BlobStorageError(
      "[BlobS3] Explicit S3 credentials require both accessKeyId and secretAccessKey."
    )
  }
  if (!options.accessKeyId || !options.secretAccessKey) return undefined

  return {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
  }
}

function objectAcl(acl: S3BlobStorageAcl | undefined): ObjectCannedACL | undefined {
  if (acl === "log-delivery-write") {
    throw new BlobStorageError(
      "[BlobS3] ACL 'log-delivery-write' is only valid for buckets, not S3 objects."
    )
  }
  return acl
}

function copySource(bucket: string, key: string): string {
  return `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}
