/**
 * End-to-end check against the real ACE Deploy API.
 *
 * Not part of `bun test` — it needs live credentials, and it walks real timeseries pages, which is
 * slower than a unit test may be. Run it directly:
 *
 *     ACE_IOT_API_KEY="…" bun connectors/ace-iot/tests/ace-iot.e2e.ts
 *
 * Optional: `ACE_IOT_BASE_URL` for a non-default deployment, and `ACE_IOT_TEST_SITE` to pin a site
 * instead of taking the first one the key can see.
 *
 * Reads only. Nothing here creates, updates, or deletes anything, and it never mints a gateway
 * token — the write surface is covered by the unit tests against mocks.
 */
import { aceIot, parseAceIotTimestamp } from "../src"

const apiKey = process.env.ACE_IOT_API_KEY
if (!apiKey) {
  console.log("[ace-iot e2e] Skipped: set ACE_IOT_API_KEY to run.")
  process.exit(0)
}

const ace = await aceIot({
  apiKey,
  baseUrl: process.env.ACE_IOT_BASE_URL,
  timeoutMs: 60_000,
}).connect({
  projectId: "e2e",
  connectorId: "ace-iot",
  signal: new AbortController().signal,
})

let failures = 0

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }

  failures += 1
  console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
}

console.log("\nclients")
const clients = await ace.clients.list({ perPage: 100 })
check("lists clients", clients.items.length > 0)
check(
  "page envelope is complete",
  typeof clients.total === "number" && typeof clients.page === "number"
)
const clientName = clients.items[0]?.name
if (clientName) {
  const client = await ace.clients.get(clientName)
  check("gets one client", client.name === clientName)
  const clientSites = await ace.clients.listSites(clientName, { perPage: 100 })
  check("lists the client's sites", Array.isArray(clientSites.items))
}

console.log("\nsites")
const sites = await ace.sites.list({ perPage: 1000 })
check("lists sites", sites.items.length > 0)
const archived = await ace.sites.list({ perPage: 1000, showArchived: true })
check("show_archived widens the result", archived.total >= sites.total, {
  visible: sites.total,
  withArchived: archived.total,
})

const siteName = process.env.ACE_IOT_TEST_SITE ?? sites.items[0]?.name
if (!siteName) {
  console.log("\nNo site visible to this key; stopping.")
  process.exit(failures > 0 ? 1 : 0)
}
console.log(`  using site ${siteName}`)

const site = await ace.sites.get(siteName)
check("gets one site", site.name === siteName)
check(
  "nullable site fields are typed as returned",
  site.address === null || typeof site.address === "string"
)

console.log("\npoints")
const points = await ace.sites.listPoints(siteName, { perPage: 50 })
check("lists site points", points.items.length > 0)
const point = points.items[0]
if (point) {
  check("point name is the slash-separated path", point.name.includes("/"))
  check("bacnet_data is an object", typeof point.bacnet_data === "object")
  check("timestamps parse as UTC", !Number.isNaN(parseAceIotTimestamp(point.created).getTime()))

  const fetched = await ace.points.get(point.name)
  check("gets a point by its slash-separated name", fetched.name === point.name)
}

const configured = await ace.sites.listConfiguredPoints(siteName, { perPage: 100 })
check("lists configured points", Array.isArray(configured.items))
check(
  "configured points are collect-enabled",
  configured.items.every((candidate) => candidate.collect_enabled)
)

console.log("\ntimeseries")
const endTime = new Date()
const startTime = new Date(endTime.getTime() - 15 * 60 * 1000)

const whole = await ace.sites.getTimeseries(siteName, { startTime, endTime })
check("reads the window unpaginated", Array.isArray(whole.point_samples))
const truth = new Set(whole.point_samples.map((sample) => `${sample.name}@${sample.time}`))
console.log(`  window holds ${whole.point_samples.length} samples`)

if (whole.point_samples.length > 0) {
  const sample = whole.point_samples[0]
  check("sample value stays a string", typeof sample.value === "string")
  check("sample time has no zone designator", !/[Zz]|[+-]\d{2}:\d{2}$/.test(sample.time))
  check("sample time parses as UTC", !Number.isNaN(parseAceIotTimestamp(sample.time).getTime()))

  // The reason this connector exists: at a page size where ACE's own cursor stalls, the repaired
  // walk still covers the window exactly once.
  const collected: string[] = []
  for await (const paged of ace.sites.iterateTimeseries(siteName, {
    startTime,
    endTime,
    pageSize: 50,
  })) {
    collected.push(`${paged.name}@${paged.time}`)
  }

  const unique = new Set(collected)
  check(
    `paginated walk at page_size=50 covers all ${truth.size} samples`,
    unique.size === truth.size,
    {
      paged: unique.size,
      truth: truth.size,
    }
  )
  check("paginated walk emits no duplicates", collected.length === unique.size, {
    total: collected.length,
    unique: unique.size,
  })
  check(
    "paginated walk returns nothing outside the window",
    [...unique].every((key) => truth.has(key))
  )

  const rawPage = await ace.sites.getTimeseriesPage(siteName, {
    startTime,
    endTime,
    pageSize: 50,
    rawData: true,
  })
  check("raw_data returns unbucketed samples", Array.isArray(rawPage.point_samples))
} else {
  console.log("  (window was empty; skipping pagination checks)")
}

const empty = await ace.sites.getTimeseriesPage(siteName, {
  startTime: "2001-01-01T00:00:00Z",
  endTime: "2001-01-01T01:00:00Z",
})
check("an empty window is a 200 with an empty page", empty.point_samples.length === 0)
check(
  "an empty window terminates the cursor",
  empty.has_more === false && empty.next_cursor === null
)

console.log("\nweather")
const weather = await ace.sites.getWeather(siteName)
check("weather is a reading set or null", weather === null || typeof weather.temp === "object")

console.log("\ngateways")
const gateways = await ace.gateways.list({ perPage: 100 })
check("lists gateways", Array.isArray(gateways.items))
const gateway = gateways.items[0]
if (gateway) {
  const fetched = await ace.gateways.get(gateway.name)
  check("gets one gateway", fetched.name === gateway.name)
  check(
    "device_token_expires parses despite its space-separated format",
    fetched.device_token_expires === null ||
      !Number.isNaN(parseAceIotTimestamp(fetched.device_token_expires).getTime())
  )
  const configs = await ace.gateways.listAgentConfigs(gateway.name, { perPage: 10 })
  check("lists agent configs", Array.isArray(configs.items))
  const agents = await ace.gateways.listVolttronAgents(gateway.name, { perPage: 10 })
  check("lists volttron agents", Array.isArray(agents.items))
  const hawke = await ace.gateways.listHawkeConfigurations(gateway.name, { perPage: 10 })
  check("lists hawke configurations", Array.isArray(hawke.items))
}

console.log("\nlocal validation")
try {
  await ace.sites.list({ perPage: 25 as 20 })
  check("an unsupported per_page is rejected locally", false)
} catch (error) {
  check(
    "an unsupported per_page is rejected locally",
    error instanceof Error && error.message.includes("perPage must be one of")
  )
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`)
process.exit(failures > 0 ? 1 : 0)
