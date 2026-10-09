import type { RestRequestInit } from "@sixb/connector-rest"
import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import type {
  ContactEmailAddress,
  ContactFolderListOptions,
  ContactGetOptions,
  ContactInput,
  ContactListOptions,
} from "../../types/contacts"
import { nonEmpty, odataString, query, segment } from "../../validation"
import { mailboxPath } from "../mail/common"

export const folderPath = (mailbox: string, id: string) =>
  `${mailboxPath(mailbox)}/contactFolders/${segment(id, "folderId")}`
/** Without a folder, Graph addresses the mailbox's default Contacts folder. */
export const contactsPath = (mailbox: string, folderId?: string) =>
  folderId === undefined
    ? `${mailboxPath(mailbox)}/contacts`
    : `${folderPath(mailbox, folderId)}/contacts`
export const contactPath = (mailbox: string, id: string, folderId?: string) =>
  `${contactsPath(mailbox, folderId)}/${segment(id, "contactId")}`

export function contactsHeaders(options?: { readonly pageSize?: number }): HeadersInit {
  // Contacts keep their ID across folder moves only with immutable IDs; folders ignore the header.
  const preferences = ['IdType="ImmutableId"']
  if (options?.pageSize !== undefined) {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0)
      throw new MicrosoftConfigurationError("pageSize must be a positive integer.")
    preferences.push(`odata.maxpagesize=${options.pageSize}`)
  }
  return { Prefer: preferences.join(", ") }
}

export function contactsQuery(
  options?: ContactGetOptions | ContactListOptions | ContactFolderListOptions
): string {
  const params = new URLSearchParams(query(options).slice(1))
  if (options && "filter" in options && options.filter !== undefined)
    params.set("$filter", nonEmpty(options.filter, "filter"))
  if (options && "email" in options && options.email !== undefined) {
    if (options.filter !== undefined)
      throw new MicrosoftConfigurationError("email cannot be combined with filter.")
    // The only email filter Graph supports on contacts: `any` with `eq` on the address.
    params.set(
      "$filter",
      `emailAddresses/any(a:a/address eq ${odataString(nonEmpty(options.email, "email"))})`
    )
  }
  return params.size ? `?${params}` : ""
}

function address(value: ContactEmailAddress | undefined, name: string): void {
  if (value !== undefined) nonEmpty(value.address ?? "", name)
}
export function validateContact(input: ContactInput): void {
  for (const email of input.emailAddresses ?? []) address(email, "email address")
  address(input.primaryEmailAddress, "primaryEmailAddress")
  address(input.secondaryEmailAddress, "secondaryEmailAddress")
  address(input.tertiaryEmailAddress, "tertiaryEmailAddress")
  if (
    input.birthday !== undefined &&
    input.birthday !== null &&
    !Number.isFinite(Date.parse(input.birthday))
  )
    throw new MicrosoftConfigurationError("birthday must be an ISO date or timestamp.")
  for (const property of [
    ...(input.singleValueExtendedProperties ?? []),
    ...(input.multiValueExtendedProperties ?? []),
  ])
    nonEmpty(property.id, "extended property id")
  for (const extension of input.extensions ?? []) nonEmpty(extension.extensionName, "extensionName")
}

/** A transport interruption cannot establish whether a contact mutation took effect. */
export class MicrosoftContactMutationError extends Error {
  readonly outcomeUnknown = true
  constructor(cause: unknown) {
    super(
      "[SixbMicrosoft] Contact mutation interrupted; reconcile the contact or folder before repeating the operation.",
      { cause }
    )
    this.name = "MicrosoftContactMutationError"
  }
}
export async function mutation(
  http: MicrosoftHttp,
  path: string,
  init: RestRequestInit
): Promise<Response> {
  try {
    return await http.request(path, init)
  } catch (cause) {
    throw new MicrosoftContactMutationError(cause)
  }
}
