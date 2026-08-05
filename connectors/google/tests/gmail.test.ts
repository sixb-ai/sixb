import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, collect, json, mockFetch, restoreFetch } from "./helpers"

const BASE = "https://gmail.googleapis.com/gmail/v1/"

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly auth: string | null
  readonly body: unknown
}

let requests: RecordedRequest[]

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "gmail-token" } }).connect(CONTEXT)
}

function record(input: RequestInfo | URL, init?: RequestInit): void {
  let body: unknown
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  requests.push({
    url: input.toString(),
    method: (init?.method ?? "GET").toString(),
    auth: new Headers(init?.headers).get("authorization"),
    body,
  })
}

function useEmptyResponses(): void {
  mockFetch(async (input, init) => {
    record(input, init)
    return json({})
  })
}

function expectRequest(index: number, method: string, path: string, body?: unknown): void {
  const request = requests[index]
  expect(request?.method).toBe(method)
  expect(request?.url).toBe(`${BASE}${path}`)
  expect(request?.auth).toBe("Bearer gmail-token")
  if (body !== undefined) {
    expect(request?.body).toEqual(body)
  }
}

beforeEach(() => {
  requests = []
})

afterEach(restoreFetch)

describe("gmail.users", () => {
  test("routes profile, watch, and stop", async () => {
    useEmptyResponses()
    const users = (await connect()).gmail.users

    await users.getProfile("me")
    await users.watch("person@example.com", {
      topicName: "projects/demo/topics/gmail",
      labelIds: ["INBOX"],
      labelFilterBehavior: "include",
    })
    await users.stop("me")

    expectRequest(0, "GET", "users/me/profile")
    expectRequest(1, "POST", "users/person%40example.com/watch", {
      topicName: "projects/demo/topics/gmail",
      labelIds: ["INBOX"],
      labelFilterBehavior: "include",
    })
    expectRequest(2, "POST", "users/me/stop")
  })
})

describe("gmail.messages", () => {
  test("lists messages with repeated query parameters and bearer auth", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ messages: [{ id: "m1", threadId: "t1" }] })
    })

    const result = await (await connect()).gmail.messages.list("me", {
      q: "from:alice@example.com is:unread",
      labelIds: ["INBOX", "IMPORTANT"],
      includeSpamTrash: true,
    })

    expect(result.messages?.[0]?.id).toBe("m1")
    const url = new URL(requests[0]?.url ?? "")
    expect(url.pathname).toBe("/gmail/v1/users/me/messages")
    expect(url.searchParams.get("q")).toBe("from:alice@example.com is:unread")
    expect(url.searchParams.getAll("labelIds")).toEqual(["INBOX", "IMPORTANT"])
    expect(url.searchParams.get("includeSpamTrash")).toBe("true")
    expect(requests[0]?.auth).toBe("Bearer gmail-token")
  })

  test("listAll follows every nextPageToken", async () => {
    const pages = [{ messages: [{ id: "m1" }], nextPageToken: "p2" }, { messages: [{ id: "m2" }] }]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(pages[call++])
    })

    const messages = await collect(
      (await connect()).gmail.messages.listAll("me", { maxResults: 1 })
    )

    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"])
    expect(new URL(requests[1]?.url ?? "").searchParams.get("pageToken")).toBe("p2")
  })

  test("routes every single-message and batch operation", async () => {
    useEmptyResponses()
    const messages = (await connect()).gmail.messages

    await messages.get("me", "m/1", { format: "metadata", metadataHeaders: ["From", "To"] })
    await messages.insert("me", { raw: "cmF3" }, { internalDateSource: "dateHeader" })
    await messages.import("me", { raw: "aW1wb3J0" }, { neverMarkSpam: true })
    await messages.send("me", { raw: "c2VuZA" })
    await messages.modify("me", "m1", { addLabelIds: ["STARRED"] })
    await messages.batchModify("me", { ids: ["m1", "m2"], removeLabelIds: ["UNREAD"] })
    await messages.batchDelete("me", { ids: ["m1", "m2"] })
    await messages.trash("me", "m1")
    await messages.untrash("me", "m1")
    await messages.delete("me", "m1")
    await messages.attachments.get("me", "m/1", "a/1")

    expectRequest(
      0,
      "GET",
      "users/me/messages/m%2F1?format=metadata&metadataHeaders=From&metadataHeaders=To"
    )
    expectRequest(1, "POST", "users/me/messages?internalDateSource=dateHeader", { raw: "cmF3" })
    expectRequest(2, "POST", "users/me/messages/import?neverMarkSpam=true", {
      raw: "aW1wb3J0",
    })
    expectRequest(3, "POST", "users/me/messages/send", { raw: "c2VuZA" })
    expectRequest(4, "POST", "users/me/messages/m1/modify", { addLabelIds: ["STARRED"] })
    expectRequest(5, "POST", "users/me/messages/batchModify", {
      ids: ["m1", "m2"],
      removeLabelIds: ["UNREAD"],
    })
    expectRequest(6, "POST", "users/me/messages/batchDelete", { ids: ["m1", "m2"] })
    expectRequest(7, "POST", "users/me/messages/m1/trash")
    expectRequest(8, "POST", "users/me/messages/m1/untrash")
    expectRequest(9, "DELETE", "users/me/messages/m1")
    expectRequest(10, "GET", "users/me/messages/m%2F1/attachments/a%2F1")
  })
})

describe("gmail.drafts", () => {
  test("routes all methods and paginates listAll", async () => {
    const pages = [{ drafts: [{ id: "d1" }], nextPageToken: "next" }, { drafts: [{ id: "d2" }] }]
    let listCalls = 0
    mockFetch(async (input, init) => {
      record(input, init)
      if (input.toString().includes("/drafts?") && init?.method === "GET") {
        return json(pages[listCalls++])
      }
      return json({})
    })

    const drafts = (await connect()).gmail.drafts
    const all = await collect(drafts.listAll("me", { maxResults: 1 }))
    await drafts.get("me", "d/1", { format: "raw" })
    await drafts.create("me", { message: { raw: "bmV3" } })
    await drafts.update("me", "d1", { message: { raw: "dXBkYXRlZA" } })
    await drafts.send("me", { id: "d1" })
    await drafts.delete("me", "d1")

    expect(all.map((draft) => draft.id)).toEqual(["d1", "d2"])
    expectRequest(0, "GET", "users/me/drafts?maxResults=1")
    expectRequest(1, "GET", "users/me/drafts?maxResults=1&pageToken=next")
    expectRequest(2, "GET", "users/me/drafts/d%2F1?format=raw")
    expectRequest(3, "POST", "users/me/drafts", { message: { raw: "bmV3" } })
    expectRequest(4, "PUT", "users/me/drafts/d1", { message: { raw: "dXBkYXRlZA" } })
    expectRequest(5, "POST", "users/me/drafts/send", { id: "d1" })
    expectRequest(6, "DELETE", "users/me/drafts/d1")
  })
})

describe("gmail.threads", () => {
  test("routes all methods and paginates listAll", async () => {
    const pages = [{ threads: [{ id: "t1" }], nextPageToken: "next" }, { threads: [{ id: "t2" }] }]
    let listCalls = 0
    mockFetch(async (input, init) => {
      record(input, init)
      if (input.toString().includes("/threads?") && init?.method === "GET") {
        return json(pages[listCalls++])
      }
      return json({})
    })

    const threads = (await connect()).gmail.threads
    const all = await collect(threads.listAll("me", { labelIds: ["INBOX"] }))
    await threads.get("me", "t1", { format: "metadata", metadataHeaders: ["Subject"] })
    await threads.modify("me", "t1", { addLabelIds: ["IMPORTANT"] })
    await threads.trash("me", "t1")
    await threads.untrash("me", "t1")
    await threads.delete("me", "t1")

    expect(all.map((thread) => thread.id)).toEqual(["t1", "t2"])
    expectRequest(0, "GET", "users/me/threads?labelIds=INBOX")
    expectRequest(1, "GET", "users/me/threads?labelIds=INBOX&pageToken=next")
    expectRequest(2, "GET", "users/me/threads/t1?format=metadata&metadataHeaders=Subject")
    expectRequest(3, "POST", "users/me/threads/t1/modify", { addLabelIds: ["IMPORTANT"] })
    expectRequest(4, "POST", "users/me/threads/t1/trash")
    expectRequest(5, "POST", "users/me/threads/t1/untrash")
    expectRequest(6, "DELETE", "users/me/threads/t1")
  })
})

describe("gmail.labels and gmail.history", () => {
  test("routes every label operation", async () => {
    useEmptyResponses()
    const labels = (await connect()).gmail.labels

    await labels.list("me")
    await labels.get("me", "CATEGORY/WORK")
    await labels.create("me", { name: "Receipts", labelListVisibility: "labelShow" })
    await labels.update("me", "Label_1", { name: "Invoices" })
    await labels.patch("me", "Label_1", { messageListVisibility: "hide" })
    await labels.delete("me", "Label_1")

    expectRequest(0, "GET", "users/me/labels")
    expectRequest(1, "GET", "users/me/labels/CATEGORY%2FWORK")
    expectRequest(2, "POST", "users/me/labels", {
      name: "Receipts",
      labelListVisibility: "labelShow",
    })
    expectRequest(3, "PUT", "users/me/labels/Label_1", { name: "Invoices" })
    expectRequest(4, "PATCH", "users/me/labels/Label_1", { messageListVisibility: "hide" })
    expectRequest(5, "DELETE", "users/me/labels/Label_1")
  })

  test("history listAll preserves filters and uses repeated historyTypes", async () => {
    const pages = [
      { history: [{ id: "101" }], nextPageToken: "next" },
      { history: [{ id: "102" }], historyId: "102" },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(pages[call++])
    })

    const history = await collect(
      (await connect()).gmail.history.listAll("me", {
        startHistoryId: "100",
        historyTypes: ["messageAdded", "labelAdded"],
      })
    )

    expect(history.map((entry) => entry.id)).toEqual(["101", "102"])
    const first = new URL(requests[0]?.url ?? "")
    expect(first.searchParams.get("startHistoryId")).toBe("100")
    expect(first.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "labelAdded"])
    expect(new URL(requests[1]?.url ?? "").searchParams.get("pageToken")).toBe("next")
  })
})

describe("gmail.settings", () => {
  test("routes all direct setting reads and updates", async () => {
    useEmptyResponses()
    const settings = (await connect()).gmail.settings

    await settings.getAutoForwarding("me")
    await settings.updateAutoForwarding("me", { enabled: true, emailAddress: "to@example.com" })
    await settings.getImap("me")
    await settings.updateImap("me", { enabled: true })
    await settings.getLanguage("me")
    await settings.updateLanguage("me", { displayLanguage: "fr" })
    await settings.getPop("me")
    await settings.updatePop("me", { accessWindow: "allMail" })
    await settings.getVacation("me")
    await settings.updateVacation("me", { enableAutoReply: true, responseSubject: "Away" })

    expectRequest(0, "GET", "users/me/settings/autoForwarding")
    expectRequest(1, "PUT", "users/me/settings/autoForwarding", {
      enabled: true,
      emailAddress: "to@example.com",
    })
    expectRequest(2, "GET", "users/me/settings/imap")
    expectRequest(3, "PUT", "users/me/settings/imap", { enabled: true })
    expectRequest(4, "GET", "users/me/settings/language")
    expectRequest(5, "PUT", "users/me/settings/language", { displayLanguage: "fr" })
    expectRequest(6, "GET", "users/me/settings/pop")
    expectRequest(7, "PUT", "users/me/settings/pop", { accessWindow: "allMail" })
    expectRequest(8, "GET", "users/me/settings/vacation")
    expectRequest(9, "PUT", "users/me/settings/vacation", {
      enableAutoReply: true,
      responseSubject: "Away",
    })
  })

  test("routes forwarding address, filter, and delegate resources", async () => {
    useEmptyResponses()
    const settings = (await connect()).gmail.settings

    await settings.forwardingAddresses.list("me")
    await settings.forwardingAddresses.get("me", "forward@example.com")
    await settings.forwardingAddresses.create("me", { forwardingEmail: "new@example.com" })
    await settings.forwardingAddresses.delete("me", "forward@example.com")
    await settings.filters.list("me")
    await settings.filters.get("me", "f/1")
    await settings.filters.create("me", { criteria: { from: "a@example.com" }, action: {} })
    await settings.filters.delete("me", "f1")
    await settings.delegates.list("me")
    await settings.delegates.get("me", "delegate@example.com")
    await settings.delegates.create("me", { delegateEmail: "delegate@example.com" })
    await settings.delegates.delete("me", "delegate@example.com")

    expectRequest(0, "GET", "users/me/settings/forwardingAddresses")
    expectRequest(1, "GET", "users/me/settings/forwardingAddresses/forward%40example.com")
    expectRequest(2, "POST", "users/me/settings/forwardingAddresses", {
      forwardingEmail: "new@example.com",
    })
    expectRequest(3, "DELETE", "users/me/settings/forwardingAddresses/forward%40example.com")
    expectRequest(4, "GET", "users/me/settings/filters")
    expectRequest(5, "GET", "users/me/settings/filters/f%2F1")
    expectRequest(6, "POST", "users/me/settings/filters", {
      criteria: { from: "a@example.com" },
      action: {},
    })
    expectRequest(7, "DELETE", "users/me/settings/filters/f1")
    expectRequest(8, "GET", "users/me/settings/delegates")
    expectRequest(9, "GET", "users/me/settings/delegates/delegate%40example.com")
    expectRequest(10, "POST", "users/me/settings/delegates", {
      delegateEmail: "delegate@example.com",
    })
    expectRequest(11, "DELETE", "users/me/settings/delegates/delegate%40example.com")
  })

  test("routes send-as and nested S/MIME resources", async () => {
    useEmptyResponses()
    const sendAs = (await connect()).gmail.settings.sendAs

    await sendAs.list("me")
    await sendAs.get("me", "alias@example.com")
    await sendAs.create("me", { sendAsEmail: "alias@example.com" })
    await sendAs.update("me", "alias@example.com", { displayName: "Alias" })
    await sendAs.patch("me", "alias@example.com", { signature: "Regards" })
    await sendAs.verify("me", "alias@example.com")
    await sendAs.delete("me", "alias@example.com")
    await sendAs.smimeInfo.list("me", "alias@example.com")
    await sendAs.smimeInfo.get("me", "alias@example.com", "s/1")
    await sendAs.smimeInfo.insert("me", "alias@example.com", { pkcs12: "base64" })
    await sendAs.smimeInfo.setDefault("me", "alias@example.com", "s1")
    await sendAs.smimeInfo.delete("me", "alias@example.com", "s1")

    expectRequest(0, "GET", "users/me/settings/sendAs")
    expectRequest(1, "GET", "users/me/settings/sendAs/alias%40example.com")
    expectRequest(2, "POST", "users/me/settings/sendAs", { sendAsEmail: "alias@example.com" })
    expectRequest(3, "PUT", "users/me/settings/sendAs/alias%40example.com", {
      displayName: "Alias",
    })
    expectRequest(4, "PATCH", "users/me/settings/sendAs/alias%40example.com", {
      signature: "Regards",
    })
    expectRequest(5, "POST", "users/me/settings/sendAs/alias%40example.com/verify")
    expectRequest(6, "DELETE", "users/me/settings/sendAs/alias%40example.com")
    expectRequest(7, "GET", "users/me/settings/sendAs/alias%40example.com/smimeInfo")
    expectRequest(8, "GET", "users/me/settings/sendAs/alias%40example.com/smimeInfo/s%2F1")
    expectRequest(9, "POST", "users/me/settings/sendAs/alias%40example.com/smimeInfo", {
      pkcs12: "base64",
    })
    expectRequest(
      10,
      "POST",
      "users/me/settings/sendAs/alias%40example.com/smimeInfo/s1/setDefault"
    )
    expectRequest(11, "DELETE", "users/me/settings/sendAs/alias%40example.com/smimeInfo/s1")
  })

  test("routes and paginates CSE identities and keypairs", async () => {
    const identityPages = [
      { cseIdentities: [{ emailAddress: "one@example.com" }], nextPageToken: "i2" },
      { cseIdentities: [{ emailAddress: "two@example.com" }] },
    ]
    const keyPairPages = [
      { cseKeyPairs: [{ keyPairId: "k1" }], nextPageToken: "k2" },
      { cseKeyPairs: [{ keyPairId: "k2" }] },
    ]
    let identityCall = 0
    let keyPairCall = 0
    mockFetch(async (input, init) => {
      record(input, init)
      const url = input.toString()
      if (init?.method === "GET" && url.includes("/cse/identities?")) {
        return json(identityPages[identityCall++])
      }
      if (init?.method === "GET" && url.includes("/cse/keypairs?")) {
        return json(keyPairPages[keyPairCall++])
      }
      return json({})
    })

    const cse = (await connect()).gmail.settings.cse
    const identities = await collect(cse.identities.listAll("me", { pageSize: 1 }))
    await cse.identities.get("me", "one@example.com")
    await cse.identities.create("me", { emailAddress: "new@example.com", primaryKeyPairId: "k1" })
    await cse.identities.patch("me", "one@example.com", { primaryKeyPairId: "k2" })
    await cse.identities.delete("me", "one@example.com")
    const keypairs = await collect(cse.keypairs.listAll("me", { pageSize: 1 }))
    await cse.keypairs.get("me", "k/1")
    await cse.keypairs.create("me", { pkcs7: "cert" }, { chainValidation: "none" })
    await cse.keypairs.enable("me", "k1")
    await cse.keypairs.disable("me", "k1")
    await cse.keypairs.obliterate("me", "k1")

    expect(identities.map((identity) => identity.emailAddress)).toEqual([
      "one@example.com",
      "two@example.com",
    ])
    expect(keypairs.map((keypair) => keypair.keyPairId)).toEqual(["k1", "k2"])
    expectRequest(0, "GET", "users/me/settings/cse/identities?pageSize=1")
    expectRequest(1, "GET", "users/me/settings/cse/identities?pageSize=1&pageToken=i2")
    expectRequest(2, "GET", "users/me/settings/cse/identities/one%40example.com")
    expectRequest(3, "POST", "users/me/settings/cse/identities", {
      emailAddress: "new@example.com",
      primaryKeyPairId: "k1",
    })
    expectRequest(4, "PATCH", "users/me/settings/cse/identities/one%40example.com", {
      primaryKeyPairId: "k2",
    })
    expectRequest(5, "DELETE", "users/me/settings/cse/identities/one%40example.com")
    expectRequest(6, "GET", "users/me/settings/cse/keypairs?pageSize=1")
    expectRequest(7, "GET", "users/me/settings/cse/keypairs?pageSize=1&pageToken=k2")
    expectRequest(8, "GET", "users/me/settings/cse/keypairs/k%2F1")
    expectRequest(9, "POST", "users/me/settings/cse/keypairs?chainValidation=none", {
      pkcs7: "cert",
    })
    expectRequest(10, "POST", "users/me/settings/cse/keypairs/k1:enable", {})
    expectRequest(11, "POST", "users/me/settings/cse/keypairs/k1:disable", {})
    expectRequest(12, "POST", "users/me/settings/cse/keypairs/k1:obliterate", {})
  })
})

describe("gmail path validation", () => {
  test("rejects empty required path parameters before issuing a request", async () => {
    useEmptyResponses()
    const gmail = (await connect()).gmail

    expect(() => gmail.users.getProfile("  ")).toThrow("userId must not be empty")
    expect(() => gmail.messages.get("me", "")).toThrow("messageId must not be empty")
    expect(() => gmail.settings.sendAs.get("me", " ")).toThrow("sendAsEmail must not be empty")
    expect(requests).toHaveLength(0)
  })
})
