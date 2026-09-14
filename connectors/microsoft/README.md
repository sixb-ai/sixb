# @sixb/connector-microsoft

Typed Microsoft Graph v1.0 connector for Sixb. Covers SharePoint Online sites, document libraries,
files, folders and incremental synchronization. Uses `@sixb/connector-rest` for HTTP and Microsoft's
`@azure/msal-node` for application authentication. Targets the global Microsoft 365 cloud.

## Quick start

```ts
// connectors/microsoft.ts
import { defineConnector } from "@sixb/core"
import { microsoft } from "@sixb/connector-microsoft"

export default defineConnector("microsoft", microsoft({
  auth: {
    tenantId: process.env.MICROSOFT_TENANT_ID!,
    clientId: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
  },
}))
```

For a standalone script, connect the adapter directly:

```ts
import { microsoft } from "@sixb/connector-microsoft"

const controller = new AbortController()
const client = await microsoft({
  auth: {
    tenantId: process.env.MICROSOFT_TENANT_ID!,
    clientId: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
  },
}).connect({ projectId: "demo", connectorId: "microsoft", signal: controller.signal })

const site = await client.sites.getByUrl("https://contoso.sharepoint.com/sites/Operations")
for await (const drive of client.sites.listAllDrives(site.id)) {
  for await (const item of client.drives.items.listAllChildren(drive.id)) {
    console.log(item.id, item.name)
  }
}
```

`getByUrl` accepts the actual site URL, not a sharing link or a library view URL. File paths supplied
to `getByPath` are unencoded and relative to the library root. Use IDs for stable references across
renames. `"root"` is accepted wherever a folder/item ID is expected; moves resolve its real ID.

## Administrator setup

1. In Entra **App registrations**, create a single-tenant application in the target organization.
   Record its **Directory (tenant) ID** and **Application (client) ID**. No redirect URI or Microsoft
   publisher review is needed for this server-to-server setup.
2. Add a certificate, or create a client secret. For a secret, retain its **value**, not its ID.
3. Under **API permissions**, add **Microsoft Graph → Application permissions → Sites.Selected**.
   A suitably privileged Entra administrator must grant admin consent. An ordinary user, site owner,
   or application owner alone cannot grant this Graph application consent.
4. Grant the application `read` or `write` on each selected site. Consent to `Sites.Selected` alone
   grants no data access. Provisioning is performed by a separately authorized administrator/tool;
   the runtime connector does not grant itself additional permissions.

The site grant uses Graph's `POST /sites/{siteId}/permissions` endpoint:

```json
{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": {
      "id": "APPLICATION-CLIENT-ID",
      "displayName": "Sixb"
    }
  }]
}
```

This provisioning endpoint requires its own administrative permissions, described in the
[site permission API](https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0).
Do not add broad permission-management rights to the runtime app to perform this step.
See [Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) and
[admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).
The configured identity operates as the application, without user impersonation or daily sign-in.

## Authentication

Choose exactly one mode. Credential discovery is never implicit.

- **Client secret**: `{ tenantId, clientId, clientSecret }`.
- **Client certificate**: `{ tenantId, clientId, clientCertificate: { thumbprintSha256, privateKey } }`.
  Upload the public certificate in Entra. Supply its 64-character hexadecimal SHA-256 fingerprint
  and matching PEM RSA private key to the connector. Keep the private key in a secret store.
- **Token resolver**: `{ token: ({ signal, forceRefresh }) => Promise<string> }`.
  The caller supplies a Graph token and owns its lifetime. Suitable for delegated access, managed
  identity or federation through the appropriate Microsoft identity library. On `forceRefresh`,
  bypass any caller-owned token cache. Honor `signal` during acquisition.

MSAL owns token caching, renewal and certificate signing for the credential modes. Concurrent
acquisitions are coalesced. Application tokens request `https://graph.microsoft.com/.default`;
permissions come from the administrator's configuration, not a scopes array in application code.
A read receiving `401` refreshes once; `403` is returned without changing tokens.

`timeoutMs` defaults to 30 seconds per HTTP attempt (auth, Graph and media). `minDelayMs` and `retry`
use the REST connector's policies; reads default to two retries and respect `Retry-After`.
The connection's `AbortSignal` applies throughout. Individual methods also accept `signal`.
MSAL 6's default token POST transport does not expose a timeout: the connector uses its supported
`networkClient` extension with Sixb REST, including timeout and cancellation. No MSAL fork is used.

## Files and folders

```ts
const root = await client.drives.items.get(driveId, "root")
const folder = await client.drives.items.createFolder(driveId, root.id, "Reports")
const file = await client.drives.uploads.upload(
  driveId,
  { parentId: folder.id, name: "report.pdf" },
  Bun.file("./report.pdf")
)

await Bun.write("./downloaded.pdf", await client.drives.items.download(driveId, file.id))
await client.drives.items.rename(driveId, file.id, "report-final.pdf", { ifMatch: file.eTag })
await client.drives.items.move(driveId, file.id, "root")
await client.drives.items.delete(driveId, file.id)
```

`download` returns bytes. For large downloads, `downloadResponse` returns a streaming `Response`:
consume it with `Bun.write(destination, response)` or cancel its body. Tokens never follow media
redirects. Authenticated pagination links are restricted to the configured global Graph v1.0 origin.

New files/folders default to conflict behavior `fail`. File uploads also accept `replace` and `rename`;
folder creation accepts `rename`. Uploading to `{ itemId }` replaces that file's content by default.
Use `ifMatch` on rename/move/delete to detect concurrent edits (`412`). For uploads, Graph checks
`ifMatch` when creating the session; this connector does not promise a lock against edits made
after session creation or a second conditional check at final commit.
Mutations are single-attempt even with a custom retry policy: a timeout does not establish whether
the write took effect. Read the destination state before deciding to repeat it.

## Resumable uploads

`upload` accepts a `Blob` (including `Bun.file`), `Uint8Array`, or `ArrayBuffer`. Small files use a
binary PUT; files above 10 MiB use sessions and 10 MiB fragments. A conditional upload uses a session
even when small, preserving the documented session `If-Match` contract. Conditional empty uploads
are rejected rather than silently dropping the condition. Unconditional empty files are supported.
The random-access content requirement makes interrupted transfers resumable without buffering a
whole `Bun.file` in memory. Arbitrary unknown-length streams are not accepted.

```ts
const session = await client.drives.uploads.createSession(driveId, {
  parentId: "root", name: "archive.zip",
})
// Persist session securely if needed; uploadUrl is itself a credential.
await client.drives.uploads.resume(session, Bun.file("./archive.zip"))
// Alternatively: getStatus(session), or cancel(session).
```

On transient PUT failures or `416`, the transfer queries server state before resending. Recovery
attempts are bounded. Fragments use the configured size, independently of the missing range ends
reported by Graph. `MicrosoftUploadError` preserves the latest acknowledged session expiry and
ranges along with the underlying cause. If
`completionUnknown` is true, the final write may have completed: reconcile the destination before
starting another upload. The connector never silently replaces an expired or missing session.
Resume with the exact same complete file. Sessions remain available on failure until cancellation
or server expiry. Preauthenticated session URLs receive no Graph token and are not logged by the
connector; avoid logging entire sessions, errors or provider bodies yourself.

## Incremental synchronization

Use `delta.pages` for initial enumeration as well as subsequent changes. Folder listing is intended
for navigation; concurrent writes make it unsuitable for establishing a complete sync snapshot.

```ts
// cursor is undefined on first sync. Store it together with its drive and local sync state.
for await (const page of client.drives.delta.pages(driveId, { cursor })) {
  // Apply partial item updates by ID and stage deletions, including folder deletions.
  // In one storage transaction, persist those changes and the following checkpoint.
  // At the final deltaLink, also finalize deletions: remove folders only once empty.
  const nextCursor = page["@odata.nextLink"] ?? page["@odata.deltaLink"]
  await applyAndCheckpoint(page.value, nextCursor, {
    finalPage: page["@odata.deltaLink"] !== undefined,
  })
}
```

Process all pages, including empty pages. Graph may return an item more than once; apply changes
idempotently by ID, with the last occurrence taking precedence. Defer folder deletion until all
pages have been applied, then remove only empty folders; persist pending deletions across resumed
runs. `applyAndCheckpoint` above is application-owned storage logic. When using `select`, retain
the facets your synchronization needs, including `deleted`, `folder` and `parentReference`.
The final `deltaLink` is the checkpoint for the next run. Cursors are opaque URLs:
do not reconstruct their query strings or combine a saved cursor with new query options.
For changes-only initialization, use `delta.list(driveId, { token: "latest" })`.
`410` is exposed as `MicrosoftApiError` with `code` and `location`: it requires an explicit full
resynchronization and local-state reconciliation, not an automatic checkpoint reset.

## API surface and limits

- `sites`: `get`, `getByUrl`, `listDrives`, `listAllDrives`.
- `drives`: `get`; `items`: `get`, `getByPath`, `listChildren`, `listAllChildren`, `download`,
  `downloadResponse`, `createFolder`, `rename`, `move`, `delete`.
- `drives.uploads`: `upload`, `createSession`, `getStatus`, `resume`, `cancel`.
- `drives.delta`: `list`, `pages`.

Collection responses retain Graph's `value` and annotations. Select/expand options preserve wire
properties; projections include `id` so item identity remains available. Wire types cover the
properties used by this surface, not the complete Graph schema. Optional fields may be absent.
`MicrosoftApiError` exposes status, code, requestId, retryAfter, location and the provider body.

Microsoft Graph cannot directly move files between libraries; `move` stays in one drive. Graph
also rejects replacing sensitivity-labelled file content with app-only authentication; Microsoft
requires delegated access for that operation. Retention rules and other SharePoint policies still
apply. Sovereign clouds, on-premises SharePoint, permission provisioning, cross-drive copy jobs,
webhooks and Office document-content editing are outside this package's current surface.

## Verification

```bash
bun test connectors/microsoft/tests/
bun --filter @sixb/connector-microsoft typecheck
bun --filter @sixb/connector-microsoft build
```

Tests execute real MSAL with mocked HTTP responses, verify RSA certificate assertions, exercise
pagination and credential boundaries, and simulate failed/ambiguous uploads. The opt-in live suite
requires `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_SITE_URL`
and `MICROSOFT_TEST_DRIVE_ID`. Optionally set `MICROSOFT_TEST_PARENT_ID` (defaults to the drive root).
Use a test library with application write access. The suite creates a uniquely named folder,
uploads small/empty/large files and deletes that folder in cleanup (SharePoint recycle-bin rules
apply). It skips when credentials are missing.

```bash
bun --filter @sixb/connector-microsoft test:e2e
```

## Microsoft API references

- [App-only authentication](https://learn.microsoft.com/en-us/graph/auth-v2-service)
- [MSAL token acquisition](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests)
- [Sites by path](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0)
- [Document libraries](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Path addressing](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems)
- [Children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0)
- [Download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Binary upload](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Upload sessions and recovery](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Create folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0)
- [Rename/update](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0)
- [Move](https://learn.microsoft.com/en-us/graph/api/driveitem-move?view=graph-rest-1.0)
- [Delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
- [Delta synchronization](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)
