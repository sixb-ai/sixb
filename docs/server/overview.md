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

Send JSON with the appropriate content type. This requests a project-defined action on an invoice:

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

The response acknowledges the queued request with a `runId`. Read `/api/action-runs/:runId` to check completion. A successful request does not mean the operation has finished.

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

With the built-in PostgreSQL and SQLite providers, upload sessions are currently held in the serving process. Route a session's requests to one instance; a restart loses it. Single-request uploads are unaffected.

## Errors

Check the HTTP status and structured error code instead of parsing message text. See [Errors](../errors/overview.md) for the response format and code reference.

## Custom server setup

Most projects start the API through the [CLI](../cli/overview.md#production-services). If you need to embed it in your own process, use `createSixbServer` from `@sixb/server`; the [package README](https://github.com/sixb-ai/sixb/tree/main/packages/server#readme) documents its options.

For builds, public origins, and service health checks, see [Deployment](../deployment/overview.md).
