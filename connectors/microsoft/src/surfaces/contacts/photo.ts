import { readResponseBody } from "@sixb/connector-rest"
import { MicrosoftApiError, MicrosoftConfigurationError } from "../../errors"
import { checkEmpty, type MicrosoftHttp } from "../../http"
import type { ContactFolderOptions, ContactPhoto } from "../../types/contacts"
import type { FileContent } from "../../types/files"
import { resource } from "../../validation"
import { contactPath, contactsHeaders, mutation } from "./common"

const MAX_PHOTO_SIZE = 4 * 1024 * 1024

export interface ContactPhotoResource {
  /** Metadata (size and media type) of the largest available photo. */
  get(mailbox: string, contactId: string, options?: ContactFolderOptions): Promise<ContactPhoto>
  /** Photo bytes as a streaming response; consume or cancel its body. Graph answers 404 without a photo. */
  downloadResponse(
    mailbox: string,
    contactId: string,
    options?: ContactFolderOptions
  ): Promise<Response>
  download(mailbox: string, contactId: string, options?: ContactFolderOptions): Promise<Uint8Array>
  /** Replaces the photo with a JPEG of at most 4 MB. Graph has no delete for contact photos. */
  upload(
    mailbox: string,
    contactId: string,
    content: FileContent,
    options?: ContactFolderOptions
  ): Promise<void>
}
function jpeg(content: FileContent): Blob {
  const data =
    content instanceof Blob
      ? content
      : content instanceof Uint8Array
        ? new Blob([new Uint8Array(content)])
        : content instanceof ArrayBuffer
          ? new Blob([content])
          : undefined
  if (!data)
    throw new MicrosoftConfigurationError(
      "Photo content must be a Blob, Uint8Array or ArrayBuffer."
    )
  if (!data.size || data.size > MAX_PHOTO_SIZE)
    throw new MicrosoftConfigurationError("A contact photo must be between 1 byte and 4 MB.")
  return data
}
export function contactPhotoResource(http: MicrosoftHttp): ContactPhotoResource {
  const photo: ContactPhotoResource = {
    async get(mailbox, contactId, options) {
      return resource(
        await http.json(`${contactPath(mailbox, contactId, options?.folderId)}/photo`, {
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
    async downloadResponse(mailbox, contactId, options) {
      const response = await http.request(
        `${contactPath(mailbox, contactId, options?.folderId)}/photo/$value`,
        { headers: contactsHeaders(), signal: options?.signal }
      )
      if (!response.ok) throw new MicrosoftApiError(response, await readResponseBody(response))
      return response
    },
    async download(mailbox, contactId, options) {
      return new Uint8Array(
        await (await photo.downloadResponse(mailbox, contactId, options)).arrayBuffer()
      )
    },
    async upload(mailbox, contactId, content, options) {
      const body = jpeg(content)
      await checkEmpty(
        await mutation(http, `${contactPath(mailbox, contactId, options?.folderId)}/photo/$value`, {
          method: "PUT",
          body,
          headers: { ...contactsHeaders(), "Content-Type": "image/jpeg" },
          signal: options?.signal,
        })
      )
    },
  }
  return photo
}
