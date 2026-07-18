import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { BlobStorageError } from "@sixb/core/blob-storage/server"
import type { S3UploadApi } from "./s3-multipart-upload"
import type { S3BlobStorageOptions } from "./types"

interface AwsS3UploadApiOptions
  extends Pick<
    S3BlobStorageOptions,
    "region" | "endpoint" | "accessKeyId" | "secretAccessKey" | "sessionToken" | "pathStyle"
  > {
  readonly bucket: string
}

export function createAwsS3UploadApi(options: AwsS3UploadApiOptions): S3UploadApi {
  const client = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.pathStyle,
    credentials:
      options.accessKeyId && options.secretAccessKey
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
          }
        : undefined,
    // Part retries are controlled by the provider because Uint8Array bodies are safely replayable.
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })

  return {
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentMD5: input.contentMd5,
          ContentType: input.mediaType,
        }),
        { abortSignal: input.signal }
      )
    },

    async createMultipartUpload(input) {
      const response = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: options.bucket,
          Key: input.key,
          ContentType: input.mediaType,
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
          Bucket: options.bucket,
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
          Bucket: options.bucket,
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
          Bucket: options.bucket,
          Key: input.key,
          UploadId: input.uploadId,
        })
      )
    },
  }
}
