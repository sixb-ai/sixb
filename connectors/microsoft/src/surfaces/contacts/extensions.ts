import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import type {
  ContactExtension,
  ContactExtensionInput,
  ContactFolderOptions,
} from "../../types/contacts"
import { nonEmpty, resource, segment } from "../../validation"
import { contactPath, contactsHeaders, mutation } from "./common"

/** Open extensions on an existing contact. Read them all with `items.get(…, { expand: "extensions" })`. */
export interface ContactExtensionsResource {
  create(
    mailbox: string,
    contactId: string,
    input: ContactExtensionInput,
    options?: ContactFolderOptions
  ): Promise<ContactExtension>
  /** `extensionId` is the extension name or its fully qualified `id`. */
  get(
    mailbox: string,
    contactId: string,
    extensionId: string,
    options?: ContactFolderOptions
  ): Promise<ContactExtension>
  /** Merges the given values into the extension; omitted properties are kept. */
  update(
    mailbox: string,
    contactId: string,
    input: ContactExtensionInput,
    options?: ContactFolderOptions
  ): Promise<ContactExtension>
  delete(
    mailbox: string,
    contactId: string,
    extensionId: string,
    options?: ContactFolderOptions
  ): Promise<void>
}
export function contactExtensionsResource(http: MicrosoftHttp): ContactExtensionsResource {
  const path = (mailbox: string, contactId: string, options?: ContactFolderOptions) =>
    `${contactPath(mailbox, contactId, options?.folderId)}/extensions`
  const extension = (
    mailbox: string,
    contactId: string,
    id: string,
    options?: ContactFolderOptions
  ) => `${path(mailbox, contactId, options)}/${segment(id, "extensionId")}`
  const write = async (url: string, method: string, body: unknown, signal?: AbortSignal) =>
    resource<ContactExtension>(
      await readJson(
        await mutation(http, url, { method, body, headers: contactsHeaders(), signal })
      )
    )
  return {
    async create(mailbox, contactId, input, options) {
      nonEmpty(input.extensionName, "extensionName")
      return write(
        path(mailbox, contactId, options),
        "POST",
        { "@odata.type": "microsoft.graph.openTypeExtension", ...input },
        options?.signal
      )
    },
    async get(mailbox, contactId, extensionId, options) {
      return resource(
        await http.json(extension(mailbox, contactId, extensionId, options), {
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
    async update(mailbox, contactId, input, options) {
      return write(
        extension(mailbox, contactId, nonEmpty(input.extensionName, "extensionName"), options),
        "PATCH",
        { "@odata.type": "#microsoft.graph.openTypeExtension", ...input },
        options?.signal
      )
    },
    async delete(mailbox, contactId, extensionId, options) {
      await checkEmpty(
        await mutation(http, extension(mailbox, contactId, extensionId, options), {
          method: "DELETE",
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
  }
}
