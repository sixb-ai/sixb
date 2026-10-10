# HTTP API

The Sixb API exposes your project's data and operations over HTTP. Requests are authenticated and checked against the caller's permissions.

During development, `bun sixb dev` serves the API at `http://localhost:3002` by default. In production, use the configured API origin.

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

The response is the finished action run. A run that failed is still a `200` response, with `status: "failed"` and its `error`. An error status usually means no run was requested, but a `500` can follow a run that started: send the request again with the same `runId` to get that run's record. A request that reuses the `runId` of a run still in progress gets `409`, and a server that is shutting down answers `503` without starting anything. See [Actions](../actions/overview.md#request-an-action).

Sync, pipeline, and workflow run requests instead answer with a `runId` once the run is queued. Read the matching run endpoint, such as `/api/workflow-runs/:runId`, to check completion.

For paginated reads, use the parameters and continuation fields documented on that endpoint. Object queries return a `nextPageToken`; see [Paginate results](object-queries.md#paginate-results).

## Files

Upload a small file with `POST /api/files` using multipart form data. Larger uploads can use the `/api/files/uploads` session endpoints described in OpenAPI.

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

## Custom server setup

Most projects start the API through the [CLI](../cli/overview.md#production-services). If you need to embed it in your own process, use `createSixbServer` from `@sixb/server`; the [package README](https://github.com/sixb-ai/sixb/tree/main/packages/server#readme) documents its options.

For builds, public origins, and service health checks, see [Deployment](../deployment/overview.md).
