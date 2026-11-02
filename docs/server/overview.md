# HTTP API

The Sixb API exposes your project's data and operations over HTTP. Requests are authenticated and checked against the caller's permissions.

During development, `bun sixb dev` serves the API at `http://localhost:3001` by default. In production, use the configured API origin.

## Explore the API

Open `/docs` on your API server for the generated OpenAPI reference. It includes endpoints, parameters, request bodies, response schemas, and authentication requirements.

| Area | Example endpoint |
| --- | --- |
| Objects | `GET /api/objects` |
| Queries | `POST /api/objects/query` |
| Actions | `POST /api/actions/:actionId` |
| Workflows | `POST /api/workflows/:id/runs` |
| Datasets | `GET /api/datasets` |
| Events | `GET /api/events` |
| Logs | `GET /api/logs` |
| Members | `GET /api/users` |
| Project | `GET /api/project` |

For TypeScript callers, the [Client SDK](../client/overview.md) provides typed functions for these endpoints. See [Object queries](object-queries.md) for the JSON query format and [WebSockets](../websockets/overview.md) for live streams.

## Authenticate a request

Scripts and external services use a [personal or service-account token](../auth/members.md#service-accounts-and-tokens):

```bash
curl https://api.example.com/api/objects \
  -H "Authorization: Bearer $SIXB_API_TOKEN"
```

Tokens carry their identity's permissions. They work only on routes that support bearer authentication, as indicated in OpenAPI; browser sign-in and WebSockets require sessions.

Browser apps use session cookies. Mutating requests also send the CSRF token in `x-sixb-csrf`, and the browser origin must be allowed by the API. Sixb-served apps handle this automatically; standalone apps should use the [browser client](../client/overview.md#standalone-browser-apps).

Being authenticated does not grant data access or member-management rights. Configure those through [Security](../auth/authorization.md).

## Send a request

Send JSON with the appropriate content type. This runs a project-defined action on an invoice:

```bash
curl https://api.example.com/api/actions/markPaid \
  -H "Authorization: Bearer $SIXB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": {
      "kind": "object",
      "objectTypeId": "Invoice",
      "primaryId": "inv-1"
    },
    "params": {}
  }'
```

The response is the finished action run. A run that failed is still a `200` response, with `status: "failed"` and its `error`. The response does not wait for the action's effects, which run after it. An error status usually means no run was requested, but a `500` can follow a run that started: send the request again with the same `runId` to get that run's record, or to run it again when it was never recorded. A request that reuses the `runId` of a run this server is still running gets `409`, and a server that is shutting down answers `503` without starting anything. See [Actions](../actions/overview.md#request-an-action).

Sync, pipeline, and workflow run requests instead answer with a `runId` once the run is queued. Read the matching run endpoint, such as `/api/workflow-runs/:runId`, to check completion.

For paginated reads, use the parameters and continuation fields documented on that endpoint. Object queries return a `nextPageToken`; see [Paginate results](object-queries.md#paginate-results).

A request body can be at most 1 MiB, except for file uploads, which take files up to 25 MiB. A larger request gets a `413` response.

## Files

Upload a small file with `POST /api/files` using multipart form data. Larger uploads can use the `/api/files/uploads` session endpoints described in OpenAPI. A file sent through the API can be at most 25 MiB; with S3 or Azure Blob Storage, these endpoints send larger files straight to storage instead.

Read a file through the object or run that owns its reference. For example, download the `scan` property from an invoice:

```bash
curl 'https://api.example.com/api/objects/Invoice/inv-1/files/content?path=/properties/scan' \
  -H "Authorization: Bearer $SIXB_API_TOKEN" \
  -o invoice.pdf
```

The API checks access to the owning resource before returning the bytes. For browser images and download links, use [`objectFileContentUrl`](../client/overview.md#display-files).

### Share a file with an external service

Some services fetch media from a URL instead of accepting an upload, such as Instagram images and TikTok posts. Give them a download URL: anyone holding it can read that one file until it expires, without a Sixb session.

Create the URL where you call the service, and pass it instead of the file:

```ts
const { url } = await sixb.blobs.createDownloadUrl(fileRef)
```

The URL points at your API's public origin, so set `SIXB_API_PUBLIC_ORIGIN` for the API and every worker that creates URLs. External services cannot reach local addresses such as `localhost`.

A URL is valid for one hour by default; pass `{ expiresInMs }` to choose another lifetime. Anyone who obtains the URL can read the file until then, so keep it as short as the service allows. Each call creates its own URL; pass its `id` to `sixb.blobs.revokeDownloadUrl()` to stop it early.

## Errors

Check the HTTP status and structured error code instead of parsing message text. See [Errors](../errors/overview.md) for the response format and code reference.

## Find a slow request

The API logs any request that takes a second or more, with where its time went. It names the route and the object type a query starts from, never a URL or a value:

```text
[SixbServer] Slow request: POST /api/objects/query (Timecard) 200 in 1240 ms: auth 4, storage 1200 in 2 calls, app 36
```

| Part | Covers |
| --- | --- |
| `auth` | Reading the body and identifying the caller. |
| `storage` | Time at least one storage call was running, including waiting for a connection and decoding rows. Calls made during `auth` count there. |
| `app` | Everything else: validation, permission checks and building the response. |

Set `SIXB_SERVER_TIMING=1` to also send those numbers on the response of any signed-in request. `bun sixb dev` always does. Your browser shows them in the Network tab, under a request's **Timing** section, and anything the browser waited for beyond `total` was the network or its own queue:

```http
Server-Timing: auth;dur=4.0, storage;dur=1200.0;desc="2 calls", app;dur=36.0, total;dur=1240.0
```

The header reveals how the server spends its time, so it's off by default in production, and a share or an Agent's run token never receives it.

| Variable | Default | Effect |
| --- | --- | --- |
| `SIXB_SERVER_TIMING` | Off | `1` or `true` sends the header. |
| `SIXB_SLOW_REQUEST_MS` | `1000` | How long a request takes before it's logged. `0` turns the log off. |

## Custom server setup

Most projects start the API through the [CLI](../cli/overview.md#production-services). If you need to embed it in your own process, use `createSixbServer` from `@sixb/server`; the [package README](https://github.com/sixb-ai/sixb/tree/main/packages/server#readme) documents its options.

For builds, public origins, and service health checks, see [Deployment](../deployment/overview.md).
