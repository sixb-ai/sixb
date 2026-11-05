import { readResponseBody } from "@sixb/connector-rest"
import type { ConnectorContext } from "@sixb/core"
import { FleetioApiError } from "../errors"
import type { FleetioHttp } from "../http"
import type { FleetioUploadedFile, FleetioUploadOptions } from "../types"

/** The file host from Fleetio's upload guide. It is not on Fleetio's domain. */
const UPLOAD_URL = "https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads"

interface UploadPolicy {
  readonly policy: string
  readonly signature: string
  readonly path: string
}

export interface UploadsResource {
  /**
   * Uploads a file for attaching to a record. Fleetio issues a signed policy, the file then goes to
   * its file host, and the returned `url` is passed as `file_url` when creating or updating the
   * record.
   */
  upload(file: Blob, options?: FleetioUploadOptions): Promise<FleetioUploadedFile>
}

export function uploadsResource(
  http: FleetioHttp,
  context: ConnectorContext,
  timeoutMs: number | undefined
): UploadsResource {
  return {
    async upload(file, options) {
      const { policy, signature, path } = await http.post<UploadPolicy>("uploads/policies")
      const url = new URL(UPLOAD_URL)
      url.searchParams.set("policy", policy)
      url.searchParams.set("signature", signature)
      url.searchParams.set("path", path)

      const filename = options?.filename ?? ("name" in file ? String(file.name) : undefined)
      if (filename) {
        url.searchParams.set("filename", filename)
      }

      // Plain fetch, not the REST client: that client attaches the account's credentials, and this
      // host is authorized by the signed policy and must never receive them.
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": options?.contentType ?? (file.type || "application/octet-stream"),
        },
        body: file,
        signal:
          timeoutMs === undefined
            ? context.signal
            : AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      })

      const body = await readResponseBody(response)
      if (!response.ok) {
        throw new FleetioApiError(response.status, body, response.headers)
      }

      return body as FleetioUploadedFile
    },
  }
}
