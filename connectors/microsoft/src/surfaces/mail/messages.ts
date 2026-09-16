import { MicrosoftConfigurationError } from "../../errors"
import { checkEmpty, type MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type { GraphPage, RequestOptions } from "../../types/common"
import type {
  MailDraftInput,
  MailDraftUpdate,
  MailForwardInput,
  MailGetOptions,
  MailListOptions,
  MailMessage,
  MailMessageUpdate,
  MailReplyInput,
  MailSendOptions,
  MailSendResult,
} from "../../types/mail"
import { nonEmpty, resource } from "../../validation"
import {
  accepted,
  folderPath,
  mailBytes,
  mailboxPath,
  mailHeaders,
  mailPages,
  mailQuery,
  messagePath,
} from "./common"
import { type MailMessageDeltaResource, messageDeltaResource } from "./delta"

export class MicrosoftMailSubmissionError extends Error {
  readonly outcomeUnknown = true
  constructor(cause: unknown) {
    super(
      "[SixbMicrosoft] Mail submission was interrupted; reconcile the draft or Sent Items before retrying.",
      { cause }
    )
    this.name = "MicrosoftMailSubmissionError"
  }
}
export interface MailMessagesResource {
  readonly delta: MailMessageDeltaResource
  list(mailbox: string, options?: MailListOptions): Promise<GraphPage<MailMessage>>
  listAll(mailbox: string, options?: MailListOptions): AsyncIterable<MailMessage>
  listInFolder(
    mailbox: string,
    folderId: string,
    options?: MailListOptions
  ): Promise<GraphPage<MailMessage>>
  listAllInFolder(
    mailbox: string,
    folderId: string,
    options?: MailListOptions
  ): AsyncIterable<MailMessage>
  get(mailbox: string, id: string, options?: MailGetOptions): Promise<MailMessage>
  /** Original MIME; consume or cancel the response body. */
  getMime(mailbox: string, id: string, options?: RequestOptions): Promise<Response>
  update(
    mailbox: string,
    id: string,
    input: MailMessageUpdate,
    options?: RequestOptions
  ): Promise<MailMessage>
  createDraft(
    mailbox: string,
    input: MailDraftInput,
    options?: RequestOptions
  ): Promise<MailMessage>
  updateDraft(
    mailbox: string,
    id: string,
    input: MailDraftUpdate,
    options?: RequestOptions
  ): Promise<MailMessage>
  createReply(
    mailbox: string,
    id: string,
    input?: MailReplyInput,
    options?: RequestOptions
  ): Promise<MailMessage>
  createReplyAll(
    mailbox: string,
    id: string,
    input?: MailReplyInput,
    options?: RequestOptions
  ): Promise<MailMessage>
  createForward(
    mailbox: string,
    id: string,
    input: MailForwardInput,
    options?: RequestOptions
  ): Promise<MailMessage>
  send(mailbox: string, draftId: string, options?: RequestOptions): Promise<MailSendResult>
  sendMail(
    mailbox: string,
    input: MailDraftInput,
    options?: MailSendOptions
  ): Promise<MailSendResult>
  move(
    mailbox: string,
    id: string,
    destinationId: string,
    options?: RequestOptions
  ): Promise<MailMessage>
  copy(
    mailbox: string,
    id: string,
    destinationId: string,
    options?: RequestOptions
  ): Promise<MailMessage>
  /** Graph DELETE semantics; use move(..., "deleteditems") for an explicit trash operation. */
  delete(mailbox: string, id: string, options?: RequestOptions): Promise<void>
}
function validateDraft(input: MailDraftInput): void {
  for (const header of input.internetMessageHeaders ?? []) {
    if (!/^x-[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(header.name) || /[\r\n]/.test(header.value))
      throw new MicrosoftConfigurationError(
        "Custom mail headers must start with x- and contain no line breaks."
      )
  }
}
export function messagesResource(http: MicrosoftHttp): MailMessagesResource {
  const write = async (
    path: string,
    method: string,
    input: unknown,
    options?: RequestOptions
  ): Promise<MailMessage> =>
    resource(
      await http.json(path, {
        method,
        body: input,
        headers: mailHeaders(),
        signal: options?.signal,
      })
    )
  const reply = (
    mailbox: string,
    id: string,
    action: string,
    input: MailReplyInput | undefined,
    options?: RequestOptions
  ) => {
    if (
      input?.comment !== undefined &&
      input.message &&
      "body" in input.message &&
      input.message.body !== undefined
    )
      throw new MicrosoftConfigurationError("Supply either comment or message.body, not both.")
    return write(`${messagePath(mailbox, id)}/${action}`, "POST", input ?? {}, options)
  }
  const submit = async (path: string, body: unknown, options?: RequestOptions) => {
    let response: Response
    try {
      response = await http.request(path, {
        method: "POST",
        body,
        headers: mailHeaders(),
        signal: options?.signal,
      })
    } catch (cause) {
      throw new MicrosoftMailSubmissionError(cause)
    }
    return accepted(response)
  }
  return {
    delta: messageDeltaResource(http),
    async list(mailbox, options) {
      return page(
        await http.json(`${mailboxPath(mailbox)}/messages${mailQuery(options)}`, {
          signal: options?.signal,
          headers: mailHeaders(options),
        })
      )
    },
    listAll(mailbox, options) {
      return mailPages(
        http,
        `${mailboxPath(mailbox)}/messages${mailQuery(options)}`,
        options,
        mailHeaders(options)
      )
    },
    async listInFolder(mailbox, folderId, options) {
      return page(
        await http.json(`${folderPath(mailbox, folderId)}/messages${mailQuery(options)}`, {
          signal: options?.signal,
          headers: mailHeaders(options),
        })
      )
    },
    listAllInFolder(mailbox, folderId, options) {
      return mailPages(
        http,
        `${folderPath(mailbox, folderId)}/messages${mailQuery(options)}`,
        options,
        mailHeaders(options)
      )
    },
    async get(mailbox, id, options) {
      return resource(
        await http.json(`${messagePath(mailbox, id)}${mailQuery(options)}`, {
          signal: options?.signal,
          headers: mailHeaders(options),
        })
      )
    },
    getMime(mailbox, id, options) {
      return mailBytes(http, `${messagePath(mailbox, id)}/$value`, options)
    },
    update(mailbox, id, input, options) {
      return write(messagePath(mailbox, id), "PATCH", input, options)
    },
    createDraft(mailbox, input, options) {
      validateDraft(input)
      return write(`${mailboxPath(mailbox)}/messages`, "POST", input, options)
    },
    updateDraft(mailbox, id, input, options) {
      return write(messagePath(mailbox, id), "PATCH", input, options)
    },
    createReply(mailbox, id, input, options) {
      return reply(mailbox, id, "createReply", input, options)
    },
    createReplyAll(mailbox, id, input, options) {
      return reply(mailbox, id, "createReplyAll", input, options)
    },
    createForward(mailbox, id, input, options) {
      if (!input.toRecipients.length)
        throw new MicrosoftConfigurationError("A forward requires at least one recipient.")
      return write(`${messagePath(mailbox, id)}/createForward`, "POST", input ?? {}, options)
    },
    send(mailbox, id, options) {
      return submit(`${messagePath(mailbox, id)}/send`, undefined, options)
    },
    sendMail(mailbox, input, options) {
      validateDraft(input)
      return submit(
        `${mailboxPath(mailbox)}/sendMail`,
        { message: input, saveToSentItems: options?.saveToSentItems ?? true },
        options
      )
    },
    move(mailbox, id, destinationId, options) {
      return write(
        `${messagePath(mailbox, id)}/move`,
        "POST",
        { destinationId: nonEmpty(destinationId, "destinationId") },
        options
      )
    },
    copy(mailbox, id, destinationId, options) {
      return write(
        `${messagePath(mailbox, id)}/copy`,
        "POST",
        { destinationId: nonEmpty(destinationId, "destinationId") },
        options
      )
    },
    async delete(mailbox, id, options) {
      await checkEmpty(
        await http.request(messagePath(mailbox, id), {
          method: "DELETE",
          headers: mailHeaders(),
          signal: options?.signal,
        })
      )
    },
  }
}
