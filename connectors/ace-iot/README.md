# @sixb/connector-ace-iot

Typed [ACE IoT](https://aceiot.cloud) Deploy API connector for Sixb. It covers the whole published
surface — clients, sites, points, gateways, timeseries, and weather — one method per endpoint, with
wire-shape types taken from ACE's own schema and corrected against the live API.

## Register

Create an API key in ACE, then define the connector in your project's `connectors/` directory:

```ts
import { aceIot } from "@sixb/connector-ace-iot"
import { defineConnector } from "@sixb/core"

export const aceIotConnector = defineConnector(
  "ace-iot",
  aceIot({
    apiKey: process.env.ACE_IOT_API_KEY!,
  })
)
```

`createSixb()` discovers the definition automatically. Resolve the typed client with:

```ts
const ace = await sixb.connector(aceIotConnector)
```

The key can also be an async resolver, called before every attempt, which supports rotation without
recreating the connector.

## Options

| Option | Description |
| --- | --- |
| `apiKey` | Required API key or async resolver. Sent as `Authorization: Bearer`. |
| `baseUrl` | Defaults to `https://flightdeck.aceiot.cloud/api/`. |
| `timeoutMs` | Optional per-attempt timeout. |
| `minDelayMs` | Delay between request starts. Defaults to 0 — ACE publishes no rate limit. |
| `retry` | Method-aware transient-failure policy. Defaults to two retries for reads. |

Default retries cover network errors, `429`, and `5xx` responses on reads, and honor `Retry-After`.
Writes are never replayed: `POST /points/` and `PUT /points/{name}` merge tag state, and
`POST /gateways/{name}/token` mints a credential, so a replay would issue a second one. The one
exception is `points.getTimeseriesForPoints`, a read that ACE exposes as a POST; it is marked
idempotent and retried like any other read.

## Timeseries

The reason to reach for this connector rather than calling the endpoint directly.

```ts
for await (const sample of ace.sites.iterateTimeseries("my_site", {
  startTime: new Date(Date.now() - 15 * 60_000),
  endTime: new Date(),
  pageSize: 1000,
})) {
  // sample.value is a string; sample.time is naive UTC.
}
```

`iterateTimeseries` walks the window to the end and hands back every reading exactly once.
`iterateTimeseriesPages` yields whole pages instead, and `getTimeseriesPage` returns a single page
exactly as ACE sends it, for callers persisting cursors themselves.

### ACE's cursor does not always advance

`GET /sites/{site_name}/timeseries/paginated` returns a base64 cursor that decodes to
`{"offset": N, "timestamp": "..."}`. ACE sets `offset` to the number of rows it drew from the page's
final timestamp bucket, without adding the offset the request carried in. When a page begins and
ends inside one bucket, the cursor it returns is the cursor it was given, and a plain
`while (has_more)` loop re-requests the same page forever.

Measured against a live site over a 15-minute window holding 3,222 readings:

| `page_size` | Following ACE's cursor | `iterateTimeseries` |
| --- | --- | --- |
| 50 | stalls after 2 pages — 100 rows | 65 pages, 3,222 rows, no duplicates |
| 100 | stalls after 2 pages — 200 rows | 33 pages, 3,222 rows, no duplicates |
| 500 | stalls after 2 pages — 1,000 rows | 7 pages, 3,222 rows, no duplicates |
| 1000 | 4 pages, 3,222 rows | 4 pages, identical result |

The connector recomputes the cursor from the page it just read, which the server honors correctly.
Large page sizes appear to work only because every page happens to cross a bucket boundary — the
failure is silent, so lowering `page_size` loses data rather than raising an error. Where ACE's
cursor is already right, the recomputed one is identical.

A walk that returns the same page twice raises rather than looping, so an upstream change can never
turn into an unbounded read.

### Timestamps are naive but mean UTC

Every ACE timestamp arrives without a zone designator — `2026-08-07T16:25:00` — so `new Date(value)`
reads it as **local time** and shifts it silently on any host that is not on UTC. Use the exported
parser:

```ts
import { parseAceIotTimestamp } from "@sixb/connector-ace-iot"

parseAceIotTimestamp("2026-08-07T16:25:00") // 2026-08-07T16:25:00.000Z
```

It also handles the two other shapes ACE emits: microsecond precision (`…:00.627593`, truncated to
milliseconds) and the space-separated form used by a gateway's `device_token_expires`
(`2027-03-04 19:34:54.114795`). `normalizeAceIotTimestamp` applies the same rule and stays a string.

Query bounds accept a `Date` or a string, and a naive timestamp read off a response can be passed
straight back as a bound without shifting.

### Values stay strings

`point_samples[].value` is a string on the wire, including numerics like `"1.6100000143051147"`. The
connector leaves it alone rather than introducing rounding the API never had.

## Pagination

List endpoints use ACE's `page`/`per_page` envelope, returned verbatim as
`{items, page, pages, per_page, total}`. Every `list*` has a `listAll*` companion that walks it:

```ts
for await (const point of ace.sites.listAllConfiguredPoints("my_site")) {
  // …
}
```

`listAll*` defaults to `perPage: 1000` because ACE's own default is 10. Pass `maxPages` to bound the
walk. `pages` comes back `null` on the gateway PCAP listing, so the walk also stops on an empty
page, a short page, and on reaching `total`.

`per_page` is a **closed enum**, not a range — `2, 10, 20, 30, 40, 50, 100, 500, 1000, 5000, 10000,
100000`. The timeseries endpoint takes a different one for `page_size`: `3, 10, 50, 100, 500, 1000,
5000, 10000, 50000, 100000, 300000, 500000` (it allows 3, but not 2). Both are exported as
`ACE_IOT_PER_PAGE_VALUES` and `ACE_IOT_PAGE_SIZE_VALUES`, and both are checked locally so an
unsupported size is a clear error instead of a 400 that names the value but not the allowed set.

## Clients API

| Client method | ACE endpoint |
| --- | --- |
| `ace.clients.list / listAll(options?)` | `GET /clients/` |
| `ace.clients.get(name)` | `GET /clients/{client_name}` |
| `ace.clients.create(input)` | `POST /clients/` |
| `ace.clients.listSites / listAllSites(name, options?)` | `GET /clients/{client_name}/sites` |
| `ace.clients.listDerEvents / listAllDerEvents(name, options?)` | `GET /clients/{client_name}/der_events` |
| `ace.clients.createDerEvents(name, events)` | `POST /clients/{client_name}/der_events` |
| `ace.clients.updateDerEvents(name, events)` | `PUT /clients/{client_name}/der_events` |
| `ace.clients.listVolttronAgentPackages / listAll…(name, options?)` | `GET /clients/{client_name}/volttron_agent_package/list` |
| `ace.clients.downloadVolttronAgentPackage(name, packageId)` | `GET /clients/{client_name}/volttron_agent_package` |
| `ace.clients.uploadVolttronAgentPackage(name, input)` | `POST /clients/{client_name}/volttron_agent_package` |

The record type is `AceIotClientAccount`, because `AceIotClient` is the connected SDK client.

## Sites API

| Client method | ACE endpoint |
| --- | --- |
| `ace.sites.list / listAll(options?)` | `GET /sites/` |
| `ace.sites.get(name)` | `GET /sites/{site_name}` |
| `ace.sites.create(input)` | `POST /sites/` |
| `ace.sites.listPoints / listAllPoints(name, options?)` | `GET /sites/{site_name}/points` |
| `ace.sites.listConfiguredPoints / listAllConfiguredPoints(name, options?)` | `GET /sites/{site_name}/configured_points` |
| `ace.sites.getTimeseries(name, range)` | `GET /sites/{site_name}/timeseries` |
| `ace.sites.appendTimeseries(name, samples)` | `POST /sites/{site_name}/timeseries` |
| `ace.sites.getTimeseriesPage(name, options)` | `GET /sites/{site_name}/timeseries/paginated` |
| `ace.sites.iterateTimeseries / iterateTimeseriesPages(name, options)` | Repaired cursor walk |
| `ace.sites.getWeather(name)` | `GET /sites/{site_name}/weather` |

`list` takes `collectEnabled` and `showArchived`; both default to false upstream and are omitted
unless set. `getWeather` returns `null` for a site with no weather feed, which ACE reports as a 404
carrying an all-null body.

`geo_location` is a PostGIS point as a WKB hex string, not a coordinate pair — `latitude` and
`longitude` are the readable fields.

## Points API

| Client method | ACE endpoint |
| --- | --- |
| `ace.points.list / listAll(options?)` | `GET /points/` |
| `ace.points.get(name)` | `GET /points/{point_name}` |
| `ace.points.create(points, options?)` | `POST /points/` |
| `ace.points.update(name, input, options?)` | `PUT /points/{point_name}` |
| `ace.points.getTimeseries(name, range)` | `GET /points/{point_name}/timeseries` |
| `ace.points.getTimeseriesForPoints(names, range)` | `POST /points/get_timeseries` |

Point names are slash-separated paths (`client/site/10.0.0.1-100/analogInput/1`); the connector
percent-encodes them, which is required or the request routes elsewhere.

Writes merge tags into what a point already has. Pass `overwriteMarkerTags` or `overwriteKvTags` to
replace them instead.

`bacnet_data` is typed with the 33 properties the live API returns — ACE's schema documents eleven
and types the object as free-form — plus an index signature for vendor properties outside that set.
A property the device did not answer for comes back as the literal string
`"property: unknown-property"`, not `null`.

## Gateways API

| Client method | ACE endpoint |
| --- | --- |
| `ace.gateways.list / listAll(options?)` | `GET /gateways/` |
| `ace.gateways.get(name)` | `GET /gateways/{gateway_name}` |
| `ace.gateways.create(input)` | `POST /gateways/` |
| `ace.gateways.update(name, input)` | `PATCH /gateways/{gateway_name}` |
| `ace.gateways.createToken(name)` | `POST /gateways/{gateway_name}/token` |
| `ace.gateways.listAgentConfigs / listAll…(name, options?)` | `GET /gateways/{gateway_name}/agent_configs` |
| `ace.gateways.createAgentConfigs(name, configs, options?)` | `POST /gateways/{gateway_name}/agent_configs` |
| `ace.gateways.listVolttronAgents / listAll…(name, options?)` | `GET /gateways/{gateway_name}/volttron_agents` |
| `ace.gateways.createVolttronAgents(name, agents)` | `POST /gateways/{gateway_name}/volttron_agents` |
| `ace.gateways.getVolttronAgentConfigPackage(name, identity, options?)` | `GET /gateways/{gateway_name}/volttron_agent_config_package` |
| `ace.gateways.createVolttronAgentConfigPackage(name, input, options?)` | `POST /gateways/{gateway_name}/volttron_agent_config_package` |
| `ace.gateways.listHawkeConfigurations / listAll…(name, options?)` | `GET /gateways/{gateway_name}/hawke_configuration` |
| `ace.gateways.createHawkeConfigurations(name, configs, options?)` | `POST /gateways/{gateway_name}/hawke_configuration` |
| `ace.gateways.getHawkeAgentConfiguration(name, agentId, options?)` | `GET …/hawke_configuration/{hawke_agent_id}` |
| `ace.gateways.setHawkeAgentConfiguration(name, agentId, config, options?)` | `POST …/hawke_configuration/{hawke_agent_id}` |
| `ace.gateways.listHawkeAgentConfigurations / listAll…(name, agentId, options?)` | `GET …/hawke_configuration/{hawke_agent_id}/list` |
| `ace.gateways.listDerEvents / listAllDerEvents(name, options?)` | `GET /gateways/{gateway_name}/der_events` |
| `ace.gateways.listPcapFiles / listAllPcapFiles(name, options)` | `GET /gateways/{gateway_name}/pcap/list` |
| `ace.gateways.downloadPcap(name, fileName)` | `GET /gateways/{gateway_name}/pcap` |
| `ace.gateways.uploadPcap(name, file, filename?)` | `POST /gateways/{gateway_name}/pcap` |

`interfaces` and `deploy_config` are free-form JSON blobs ACE does not describe, so they stay
`Record<string, unknown>`. Downloads return the raw `Response` with its body unread, so the caller
decides whether to buffer or stream.

## Errors

Non-successful responses throw `AceIotApiError` with the status, parsed body, headers, and
`retryAfterMs`. Flask-RESTX field validation is surfaced per parameter through `validationErrors`.

```ts
import { AceIotApiError } from "@sixb/connector-ace-iot"

try {
  await ace.sites.get("unknown_site")
} catch (error) {
  if (error instanceof AceIotApiError) {
    console.error(error.status, error.validationErrors, error.responseBody)
  }
}
```

`AceIotConfigurationError` covers problems with the connector's own setup — an empty API key, an
empty base URL. It is never retried, because it fails the same way on every attempt.

Two response behaviors worth knowing, both verified against the live API and neither in ACE's
schema:

- **An invalid API key returns `500`**, carrying Flask's generic
  `"An unhandled exception occurred."`, not a `401`. The connector appends a note saying so, because
  that message is otherwise impossible to act on. A *missing* key does return `401`.
- **An unknown site returns `403`** with a fully-null site body, while an unknown point — or an
  unknown site's points — returns `404`.

## Not covered

ACE publishes no webhooks, no delete endpoints, and no incremental change log, so the connector
exposes none. Every path in ACE's Swagger document is implemented.

## Official documentation

- [Swagger schema](https://flightdeck.aceiot.cloud/api/swagger.json) — the API's own OpenAPI 2.0 document
