# Shared access

Shared access gives someone a link to a specific object without adding them to your team. A Share definition controls what the link lets them read and which actions they may run.

## Define shared access

Export a Share definition from `shares/`. This example shares one invoice and allows the recipient to run the project's `approveInvoice` action on it.

```ts
// shares/invoice.ts
import { can, defineShare } from "@sixb/core"
import { approveInvoice } from "../actions/approve-invoice"
import { Invoice } from "../ontology/invoice"

export const invoiceShare = defineShare("invoice", {
  target: Invoice,
  grants: ({ target }) => [
    can.view(target),
    can.apply(approveInvoice).on(target),
  ],
})
```

`target` represents the exact invoice selected when the link is issued. Other invoices remain inaccessible.

To include related objects, select their links explicitly:

```ts
can.view(target).withLinks([Invoice.l.customer])
```

Nested relationships stay private unless selected too. These grants do not give the recipient direct write or upload access.

## Allow sharing

Add `can.share(invoiceShare)` to the issuer's [role](authorization.md). It permits issuing, listing, and revoking links for this definition; it does not grant access to invoice data by itself.

The issuer must also see the target when issuing the link: a target their [condition](authorization.md#grant-only-some-objects) hides is not found (`404`). The link then holds its own grants and keeps showing the target, even once it stops matching that condition. A selected link keeps showing whatever it reaches, so the issuer must view each type the selected links reach without a condition. Sixb refuses to issue it otherwise (`403`).

```ts
import { can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { invoiceShare } from "../../shares/invoice"
import { financeTeam } from "../groups/finance-team"

export const invoiceSharing = defineRole("invoice-sharing", {
  grantedTo: [financeTeam],
  grants: [can.view(Invoice), can.share(invoiceShare)],
})
```

## Issue a link

From an authenticated app, use the [Client SDK](../client/overview.md) to issue a link with an expiration and a destination in your custom app:

```ts
import { issueSharedAccessGrant } from "@sixb/client"

const { data } = await issueSharedAccessGrant({
  body: {
    definitionId: "invoice",
    target: { objectTypeId: "Invoice", primaryId: "inv-1" },
    destinationPath: "/invoices/inv-1",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  throwOnError: true,
})

const url = data.url
```

The URL is returned only when issued. Anyone holding it can use its permitted access until it expires or is revoked. The destination is a normal [app page](../apps/overview.md); its queries and action buttons use the shared session automatically. So do images, videos, and download links whose URL comes from [`objectFileContentUrl`](../client/overview.md#display-files); a file URL built by hand is not part of the shared session.

## Know who used a link

A link's recipient has no account, so an action they run has no [`requestedBy`](../actions/overview.md#know-who-requested-the-run). It still receives the [`client`](../actions/overview.md#know-where-the-request-came-from) the request came from: its IP address and user agent. Store them on an object when you need a record, such as the audit trail of a signature.

## Revoke access

Use `revokeSharedAccessGrant` with the issued grant ID. Narrowing the Share definition also narrows existing links; widening it does not add permissions to links already issued.

Your own code can revoke a link once its purpose is over, for example when the request it was issued for is declined or cancelled. Keep the grant ID when you issue the link, then call `sixb.shares.revoke(grantId)` from an action's `.writeback()` or `.effects()`, or from a workflow step:

```ts
export const declineInvoice = defineAction("declineInvoice")
  .on(Invoice)
  .params({})
  // Pass the stored grant ID on to the effects, which run once the decline is saved.
  .writeback(({ target }) => ({ grantId: target.properties.approvalGrantId ?? null }))
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({ status: "declined" })
  })
  .effects(async ({ sixb, writeback }) => {
    if (writeback.grantId) await sixb.shares.revoke(writeback.grantId)
  })
```

It returns the revoked grant, or `null` when no grant has this ID; revoking a revoked grant returns its first revocation. The grant records who revoked it as `{ type: "system", id: "action:declineInvoice" }` or `"workflow:<workflowId>"`. The link stops working on its next request, including in a browser that already opened it.

This needs no `can.share`, because the action or workflow is your code. Revoke only grant IDs your code stored, never one taken from the action's params: a link's recipient can run the action too. That code can only revoke: issuing and listing links stay with users and service accounts, and a shared session cannot revoke links, its own included.

## Customize the unavailable screen

A link that is invalid, expired, or revoked shows a generic, translated screen. Add `app/shared-unavailable.tsx` to show your own; see [Customization](../apps/customization.md#shared-link-unavailable-screen).

## Limitations

Revoke outstanding grants before permanently removing or reusing a Share definition's ID. Shared sessions currently do not support WebSockets, uploads, direct object writes, or action parameters containing object, file, or user references.
