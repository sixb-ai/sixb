import { describe, expect, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  objectRef,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { drainActionRuns } from "@sixb/core/internal/actions"
import { createTestSixb } from "@sixb/core/testing"
import { SHARED_ACCESS_GRANT_HEADER_NAME } from "../src/auth/shared-access"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// A signer declines through their shared link: the Action records where the request came from,
// then retires the link from its effects. Reproduce either half by removing `bindRequestClient`
// from `bindRequestExecution` (core `execution/request.ts`), or the trusted-primitive branch of
// `revocationActor` (core `shares/execution.ts`).

const SIGNER_AGENT = "SignerBrowser/1.0"

const Contract = defineObjectType({
  id: "trusted-code-contract",
  name: "Contract",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("signingGrantId", "string"),
    prop("declinedFrom", "string", { nullable: true }),
    prop("declinedWith", "string", { nullable: true }),
  ],
})

const declineContract = defineAction("decline-contract")
  .on(Contract)
  .params({})
  .writeback(({ target }) => ({ grantId: target.properties.signingGrantId ?? null }))
  .edits(({ objects, subject, client }) => {
    objects(Contract)
      .byId(subject.primaryId)
      .update({
        status: "declined",
        declinedFrom: client?.address ?? null,
        declinedWith: client?.userAgent ?? null,
      })
  })
  .effects(async ({ sixb, writeback }) => {
    if (writeback.grantId) await sixb.shares.revoke(writeback.grantId)
  })

const ContractSigning = defineShare("contract-signing", {
  target: Contract,
  grants: ({ target }) => [can.view(target), can.apply(declineContract).on(target)],
})

const senders = defineGroup("contract-senders")
const sender = defineRole("contract.sender", {
  grantedTo: [senders],
  grants: [can.view(Contract), can.share(ContractSigning)],
})

describe("trusted code behind a shared link", () => {
  test("an Action sees the signer's client and revokes the link it ran through", async () => {
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: "shared-trusted-code",
      ontology: [Contract],
      actions: [declineContract],
      shares: [ContractSigning],
      groups: [senders],
      roles: [sender],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      auth: { id: "test", kind: "dev" as const },
    })
    const server = new SixbServer({
      host,
      hostname: "127.0.0.1",
      port: 0,
      quiet: true,
      browser: createTestBrowserPolicy(),
    })
    await server.start()

    try {
      const baseUrl = `http://127.0.0.1:${server.getPort()}`
      await createTestSixb(host)
        .objects(Contract)
        .upsert({ properties: { id: "contract-1", status: "sent" } })
      const issuer = createTestSixb(host, {
        authorization: resolveAuthorizationContext({
          principal: { type: "user", id: "usr_sender" },
          groupIds: [senders.id],
          roles: host.definitions.security.listResolvedRoles(),
        }),
      })
      const { grant, secret } = await issuer.shares.issue(ContractSigning, {
        target: objectRef(Contract, "contract-1"),
        destinationPath: "/sign/contract-1",
        expiresAt: new Date("2098-01-01T00:00:00.000Z"),
      })
      await createTestSixb(host)
        .objects(Contract)
        .upsert({ properties: { id: "contract-1", status: "sent", signingGrantId: grant.id } })

      const exchanged = await fetch(`${baseUrl}/api/shared-access/${grant.id}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      })
      expect(exchanged.status).toBe(200)
      const { csrfToken } = (await exchanged.json()) as { readonly csrfToken: string }
      const cookie = exchanged.headers
        .getSetCookie()
        .map((value) => value.slice(0, value.indexOf(";")))
        .join("; ")
      const shared = { cookie, [SHARED_ACCESS_GRANT_HEADER_NAME]: grant.id }

      const declined = await fetch(`${baseUrl}/api/actions/${declineContract.id}`, {
        method: "POST",
        headers: {
          ...shared,
          "content-type": "application/json",
          "user-agent": SIGNER_AGENT,
          "x-sixb-csrf": csrfToken,
        },
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: Contract.id, primaryId: "contract-1" },
          params: {},
        }),
      })
      expect(declined.status).toBe(200)
      expect(await declined.json()).toMatchObject({ status: "succeeded" })
      await drainActionRuns(host, 5_000)

      const contract = await createTestSixb(host).objects(Contract).get("contract-1")
      expect(contract?.properties).toMatchObject({
        status: "declined",
        declinedFrom: "127.0.0.1",
        declinedWith: SIGNER_AGENT,
      })

      expect(
        await storage.shareGrants.getById({ projectId: host.id, id: grant.id })
      ).toHaveProperty("revokedBy", { type: "system", id: `action:${declineContract.id}` })
      const afterRevocation = await fetch(`${baseUrl}/api/objects/${Contract.id}/contract-1`, {
        headers: shared,
      })
      expect(afterRevocation.status).toBe(401)
    } finally {
      await server.stop()
    }
  })
})
