import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface AgentCliContractImplementation {
  readonly name: string
  readonly command: readonly string[]
  readonly version: string
}

interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface RecordedRequest {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

interface TestApi {
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  close(): void
}

type TestApiHandler = (
  request: RecordedRequest
) => Response | undefined | Promise<Response | undefined>

let nextTestPort = 43_100 + Math.floor(Math.random() * 1_000)

const objectTypes = [
  {
    id: "BuildingAlarm",
    name: "Building alarm",
    description: "An alarm",
    properties: [{ id: "alarmId", name: "Alarm id", primary: true, schema: "string" }],
    links: [],
    actions: [],
  },
  {
    id: "Customer",
    name: "Customer",
    description: "A customer",
    properties: [{ id: "customerId", name: "Customer id", primary: true, schema: "string" }],
    links: [],
    actions: [],
  },
  {
    id: "RepositoryIssue",
    name: "Repository issue",
    description: "A GitHub issue",
    properties: [{ id: "id", name: "Id", primary: true, schema: "string" }],
    links: [],
    actions: [],
  },
  {
    id: "ServiceCase",
    name: "Service case",
    description: "An incident",
    properties: [{ id: "caseId", name: "Case id", primary: true, schema: "string" }],
    links: [
      {
        id: "customer",
        name: "Customer",
        targetObjectTypeId: "Customer",
        cardinality: "one",
      },
      {
        id: "originatingAlarms",
        name: "Originating alarms",
        targetObjectTypeId: "BuildingAlarm",
        cardinality: "many",
      },
    ],
    actions: [
      {
        id: "dispatch-work-order",
        name: "Dispatch work order",
        description: "Dispatch field work",
      },
    ],
  },
  {
    id: "WorkOrder",
    name: "Work order",
    description: "Dispatched work",
    properties: [{ id: "workOrderId", name: "Work order id", primary: true, schema: "string" }],
    links: [
      {
        id: "case",
        name: "Case",
        targetObjectTypeId: "ServiceCase",
        cardinality: "one",
      },
    ],
    actions: [],
  },
] as const

const objects = [
  object("BuildingAlarm", "alarm-broad", { alarmId: "alarm-broad", category: "Broad" }),
  object("Customer", "customer-1", { customerId: "customer-1", name: "Northline" }),
  object("RepositoryIssue", "github:issue:sixb-ai/sixb#297", {
    id: "github:issue:sixb-ai/sixb#297",
    title: "Opaque identifiers",
  }),
  object("ServiceCase", "case-1", { caseId: "case-1", summary: "No cooling" }),
  object("WorkOrder", "wo-1040", {
    workOrderId: "wo-1040",
    status: "dispatched",
    priority: "urgent",
  }),
] as const

const links = [
  edge("ServiceCase", "case-1", "customer", "Customer", "customer-1"),
  edge("ServiceCase", "case-1", "originatingAlarms", "BuildingAlarm", "alarm-broad"),
  edge("WorkOrder", "wo-1040", "case", "ServiceCase", "case-1"),
] as const

export function runAgentCliContractSuite(implementation: AgentCliContractImplementation): void {
  describe.serial(`Sixb agent CLI contract (${implementation.name})`, () => {
    test("exposes the frozen command hierarchy and help without an API runtime", async () => {
      const commands = [
        ["--help"],
        ["doctor", "--help"],
        ["context", "--help"],
        ["project", "--help"],
        ["ontology", "--help"],
        ["objects", "--help"],
        ["objects", "inspect", "--help"],
        ["objects", "query", "--help"],
        ["telemetry", "--help"],
        ["actions", "--help"],
        ["action-runs", "--help"],
        ["files", "--help"],
        ["workflows", "--help"],
        ["workflow-runs", "--help"],
      ] as const

      for (const args of commands) {
        const result = await runCli(implementation, args)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("Usage:")
        expect(result.stderr).toBe("")
      }

      const queryHelp = await runCli(implementation, ["objects", "query", "--help"])
      expect(queryHelp.stdout).toContain('"kind":"refs"')
      expect(queryHelp.stdout).toContain("directions are outgoing or incoming")
      expect(queryHelp.stdout).toContain('"op":"eq"')
      expect(queryHelp.stdout).toContain("sourceObjectTypeId")

      const pageExample = await runCli(implementation, ["objects", "query", "--example", "page"])
      expect(JSON.parse(pageExample.stdout)).toEqual({
        kind: "page",
        input: { kind: "start", objectTypeId: "Customer" },
        pageSize: 20,
      })
      const facetsExample = await runCli(implementation, ["objects", "facets", "--example"])
      expect(JSON.parse(facetsExample.stdout)).toEqual({
        query: { kind: "start", objectTypeId: "WorkOrder" },
        facets: [{ propertyId: "status", limit: 10 }],
      })
      const mixedExample = await runCli(implementation, [
        "objects",
        "query",
        "--example",
        "page",
        "--include-total",
      ])
      expect(mixedExample.exitCode).toBe(2)

      const version = await runCli(implementation, ["--version"])
      expect(version).toEqual({ exitCode: 0, stdout: `${implementation.version}\n`, stderr: "" })
    })

    test("uses stable JSON errors and exit codes for local and API failures", async () => {
      const invalid = await runCli(implementation, [
        "objects",
        "inspect",
        "Customer",
        "customer-1",
        "--depth",
        "9",
      ])
      expect(invalid.exitCode).toBe(2)
      expect(invalid.stdout).toBe("")
      expect(JSON.parse(invalid.stderr)).toEqual({
        error: {
          code: "invalid_arguments",
          message: "--depth must be an integer from 0 through 3.",
        },
      })

      const api = startTestApi((request) => {
        if (request.url.pathname === "/api/project") {
          return json(
            {
              error: "The project is not visible.",
              code: "project_forbidden",
              hint: "Use the current run-scoped project.",
              issues: [{ path: "$", code: "forbidden", message: "Project is not visible." }],
            },
            403
          )
        }
      })
      try {
        const tempDir = await mkdtemp(join(tmpdir(), "sixb-agent-cli-json-"))
        try {
          const invalidJsonPath = join(tempDir, "invalid.json")
          await writeFile(invalidJsonPath, "{not-json")
          const invalidJson = await runCli(
            implementation,
            ["objects", "query", "--file", invalidJsonPath],
            apiEnv(api)
          )
          expect(invalidJson.exitCode).toBe(2)
          expect(invalidJson.stdout).toBe("")
          expect(JSON.parse(invalidJson.stderr)).toEqual({
            error: {
              code: "invalid_json",
              message: `JSON file '${invalidJsonPath}' is not valid JSON.`,
            },
          })
        } finally {
          await rm(tempDir, { recursive: true, force: true })
        }

        const forbidden = await runCli(implementation, ["project", "show"], apiEnv(api))
        expect(forbidden.exitCode).toBe(3)
        expect(forbidden.stdout).toBe("")
        expect(JSON.parse(forbidden.stderr)).toEqual({
          error: {
            code: "project_forbidden",
            status: 403,
            message: "The project is not visible.",
            hint: "Use the current run-scoped project.",
            issues: [{ path: "$", code: "forbidden", message: "Project is not visible." }],
          },
        })
      } finally {
        api.close()
      }
    })

    test("looks up opaque ids with one refs request and never puts them in a URL", async () => {
      const api = startGraphApi()
      try {
        const primaryId = "github:issue:sixb-ai/sixb#297"
        const result = await runCli(
          implementation,
          ["objects", "get", "RepositoryIssue", primaryId],
          { ...apiEnv(api), SIXB_AUTH_TOKEN: "must-not-be-forwarded" }
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        expect(JSON.parse(result.stdout).objects).toEqual([
          expect.objectContaining({ objectTypeId: "RepositoryIssue", primaryId }),
        ])
        expect(api.requests).toHaveLength(1)
        expect(api.requests[0]?.method).toBe("POST")
        expect(api.requests[0]?.url.pathname).toBe("/api/objects/query")
        expect(api.requests[0]?.url.href).not.toContain(encodeURIComponent(primaryId))
        expect(api.requests[0]?.headers.has("authorization")).toBe(false)
        expect(api.requests[0]?.body).toEqual({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "RepositoryIssue", primaryId }],
          },
          includeTotal: false,
        })
      } finally {
        api.close()
      }
    })

    test("inspects a two-hop graph in two requests with compact defaults", async () => {
      const api = startGraphApi()
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        const output = JSON.parse(result.stdout)
        expect(output.object).toMatchObject({ objectTypeId: "Customer", primaryId: "customer-1" })
        expect(output.object.createdAt).toBeUndefined()
        expect(output.object.updatedAt).toBeUndefined()
        expect(output.objectTypes).toBeUndefined()
        expect(
          output.relatedObjects.map(
            (value: { objectTypeId: string; primaryId: string; distance: number }) => ({
              type: value.objectTypeId,
              id: value.primaryId,
              distance: value.distance,
            })
          )
        ).toEqual([
          { type: "ServiceCase", id: "case-1", distance: 1 },
          { type: "BuildingAlarm", id: "alarm-broad", distance: 2 },
          { type: "WorkOrder", id: "wo-1040", distance: 2 },
        ])
        expect(output.links).toHaveLength(3)
        expect(output.graph).toEqual({
          depth: 2,
          maxObjects: 20,
          maxLinks: 50,
          maxPages: 10,
          objectCount: 4,
          linkCount: 3,
          pagesRead: 2,
          linksExamined: 4,
          truncated: false,
          truncation: { objects: false, links: false, pages: false },
        })

        expect(api.requests.map((request) => request.url.pathname)).toEqual([
          "/api/objects/query/links",
          "/api/objects/query/links",
        ])
        expect(api.requests[0]?.body).toEqual({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "Customer", primaryId: "customer-1" }],
          },
          direction: "both",
          includeObjects: true,
          pageSize: 50,
        })
        expect(api.requests[1]?.body).toEqual({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "ServiceCase", primaryId: "case-1" }],
          },
          direction: "both",
          includeObjects: true,
          pageSize: 49,
        })
      } finally {
        api.close()
      }
    })

    test("stops graph pagination at its link budget", async () => {
      const api = startTestApi((request) => {
        if (request.method !== "POST" || request.url.pathname !== "/api/objects/query/links") {
          return undefined
        }
        return json({
          objects: [
            object("Customer", "customer-1", { customerId: "customer-1" }),
            object("ServiceCase", "case-1", { caseId: "case-1" }),
          ],
          links: [edge("ServiceCase", "case-1", "customer", "Customer", "customer-1")],
          hasMore: true,
          nextPageToken: "unread-page",
        })
      })
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1", "--depth", "1", "--max-links", "1"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(api.requests).toHaveLength(1)
        expect(api.requests[0]?.body).toMatchObject({ pageSize: 1 })
        expect(JSON.parse(result.stdout).graph).toMatchObject({
          linkCount: 1,
          pagesRead: 1,
          linksExamined: 1,
          truncated: true,
          truncation: { objects: false, links: true, pages: false },
        })
      } finally {
        api.close()
      }
    })

    test("rejects repeated graph page tokens instead of looping", async () => {
      const api = startTestApi((request) => {
        if (request.method !== "POST" || request.url.pathname !== "/api/objects/query/links") {
          return undefined
        }
        return json({
          objects: [object("Customer", "customer-1", { customerId: "customer-1" })],
          links: [],
          hasMore: true,
          nextPageToken: "repeated-token",
        })
      })
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1", "--depth", "1"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(3)
        expect(api.requests).toHaveLength(2)
        expect(JSON.parse(result.stderr)).toEqual({
          error: {
            code: "invalid_api_response",
            message: "The object-links API repeated a nextPageToken while inspecting the graph.",
          },
        })
      } finally {
        api.close()
      }
    })

    test("stops graph pagination at its request budget", async () => {
      let page = 0
      const api = startTestApi((request) => {
        if (request.method !== "POST" || request.url.pathname !== "/api/objects/query/links") {
          return undefined
        }
        page += 1
        return json({
          objects: [object("Customer", "customer-1", { customerId: "customer-1" })],
          links: [],
          hasMore: true,
          nextPageToken: `page-${page}`,
        })
      })
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1", "--depth", "1"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(api.requests).toHaveLength(10)
        expect(JSON.parse(result.stdout).graph).toMatchObject({
          pagesRead: 10,
          linksExamined: 0,
          truncated: true,
          truncation: { objects: false, links: false, pages: true },
        })
      } finally {
        api.close()
      }
    })

    test("uses an exact refs query when graph depth is zero", async () => {
      const api = startGraphApi()
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1", "--depth", "0"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(api.requests).toHaveLength(1)
        expect(api.requests[0]?.url.pathname).toBe("/api/objects/query")
        expect(JSON.parse(result.stdout).graph).toMatchObject({
          depth: 0,
          pagesRead: 0,
          linksExamined: 0,
          truncated: false,
        })
      } finally {
        api.close()
      }
    })

    test("adds timestamps and only encountered ontology definitions with --full", async () => {
      const api = startGraphApi()
      try {
        const result = await runCli(
          implementation,
          ["objects", "inspect", "Customer", "customer-1", "--full"],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        const output = JSON.parse(result.stdout)
        expect(output.object.createdAt).toBe("2026-01-01T00:00:00.000Z")
        expect(output.relatedObjects[0].updatedAt).toBe("2026-01-02T00:00:00.000Z")
        expect(output.objectTypes.map((type: { id: string }) => type.id)).toEqual([
          "BuildingAlarm",
          "Customer",
          "ServiceCase",
          "WorkOrder",
        ])
        expect(
          output.objectTypes.find((type: { id: string }) => type.id === "ServiceCase").actions
        ).toEqual([
          {
            id: "dispatch-work-order",
            name: "Dispatch work order",
            description: "Dispatch field work",
          },
        ])
        expect(
          api.requests.filter((request) => request.url.pathname === "/api/object-types")
        ).toHaveLength(0)
        expect(api.requests).toHaveLength(6)
      } finally {
        api.close()
      }
    })

    test("reads links through the object-set terminal with both directions by default", async () => {
      const api = startGraphApi()
      try {
        const primaryId = "github:issue:sixb-ai/sixb#297"
        const result = await runCli(
          implementation,
          ["objects", "links", "RepositoryIssue", primaryId],
          apiEnv(api)
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        expect(JSON.parse(result.stdout)).toEqual({ objects: [], links: [], hasMore: false })
        expect(api.requests).toHaveLength(1)
        expect(api.requests[0]?.url.pathname).toBe("/api/objects/query/links")
        expect(api.requests[0]?.url.href).not.toContain(encodeURIComponent(primaryId))
        expect(api.requests[0]?.body).toEqual({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "RepositoryIssue", primaryId }],
          },
          direction: "both",
          includeObjects: false,
          pageSize: 100,
        })
      } finally {
        api.close()
      }
    })

    test("keeps ontology listing compact unless full definitions are requested", async () => {
      const api = startGraphApi()
      try {
        const compact = await runCli(implementation, ["ontology", "list"], apiEnv(api))
        const full = await runCli(implementation, ["ontology", "list", "--full"], apiEnv(api))

        expect(compact.exitCode).toBe(0)
        expect(full.exitCode).toBe(0)
        const compactTypes = JSON.parse(compact.stdout)
        expect(compactTypes[0]).toEqual({
          id: "BuildingAlarm",
          name: "Building alarm",
          description: "An alarm",
          primaryPropertyId: "alarmId",
          links: [],
          actions: [],
        })
        expect(compactTypes[0].properties).toBeUndefined()
        expect(JSON.parse(full.stdout)[0].properties[0]).toMatchObject({
          id: "alarmId",
          primary: true,
        })
      } finally {
        api.close()
      }
    })

    test("maps the remaining high-level commands to their gateway routes", async () => {
      const api = startTestApi((request) => {
        if (request.url.pathname.endsWith("/files/content")) {
          return new Response("downloaded bytes")
        }
        if (request.method === "GET" && request.url.pathname === "/api/actions") {
          return json([
            { id: "customer-action", objectTypeId: "Customer" },
            { id: "other-action", objectTypeId: "Other" },
          ])
        }
        return json({ ok: true })
      })
      const tempDir = await mkdtemp(join(tmpdir(), "sixb-agent-cli-surface-"))
      try {
        const queryPath = join(tempDir, "query.json")
        const facetsPath = join(tempDir, "facets.json")
        const dataPath = join(tempDir, "data.json")
        const uploadPath = join(tempDir, "upload.txt")
        const downloadPath = join(tempDir, "download.txt")
        await Promise.all([
          writeFile(queryPath, '{"kind":"start","objectTypeId":"Customer"}'),
          writeFile(facetsPath, '{"query":{"kind":"start","objectTypeId":"Customer"},"facets":[]}'),
          writeFile(dataPath, '{"value":"sent"}'),
          writeFile(uploadPath, "upload contents"),
        ])

        const commands = [
          ["objects", "list", "--type", "Customer"],
          ["objects", "search", "north line", "--limit", "4"],
          ["objects", "query", "--file", queryPath, "--include-total"],
          ["objects", "count", "--file", queryPath],
          ["objects", "exists", "--file", queryPath],
          ["objects", "facets", "--file", facetsPath],
          ["telemetry", "latest", "Device", "fan/1", "rpm"],
          ["telemetry", "history", "Device", "fan/1", "rpm", "--limit", "5"],
          ["telemetry", "query", "--file", dataPath],
          ["actions", "list", "--type", "Customer"],
          ["actions", "get", "dispatch/work"],
          [
            "actions",
            "request",
            "dispatch/work",
            "--subject-type",
            "Customer",
            "--subject-id",
            "customer/1",
            "--params-file",
            dataPath,
            "--run-id",
            "run-1",
          ],
          ["action-runs", "list", "--action", "dispatch/work", "--status", "succeeded"],
          ["action-runs", "get", "run/1"],
          ["files", "upload", uploadPath, "--logical-path", "reports/upload.txt"],
          [
            "files",
            "download",
            "object",
            "Customer",
            "customer/1",
            "--path",
            "/properties/report",
            "--output",
            downloadPath,
          ],
          ["workflows", "list"],
          ["workflows", "get", "customer/review"],
          ["workflows", "start", "customer/review", "--input-file", dataPath],
          ["workflow-runs", "list", "--workflow", "customer/review", "--limit", "3"],
          ["workflow-runs", "get", "workflow/run-1"],
        ] as const

        for (const args of commands) {
          const result = await runCli(implementation, args, apiEnv(api))
          expect(result.exitCode).toBe(0)
          expect(result.stderr).toBe("")
        }

        expect(await readFile(downloadPath, "utf8")).toBe("downloaded bytes")
        expect(api.requests.map((request) => request.url.pathname)).toEqual([
          "/api/objects",
          "/api/objects/search",
          "/api/objects/query",
          "/api/objects/query/count",
          "/api/objects/query/exists",
          "/api/objects/query/facets",
          "/api/objects/Device/fan%2F1/telemetry/rpm/latest",
          "/api/objects/Device/fan%2F1/telemetry/rpm/history",
          "/api/telemetry/history",
          "/api/actions",
          "/api/actions/dispatch%2Fwork",
          "/api/actions/dispatch%2Fwork",
          "/api/action-runs",
          "/api/action-runs/run%2F1",
          "/api/files",
          "/api/objects/Customer/customer%2F1/files/content",
          "/api/workflows",
          "/api/workflows/customer%2Freview",
          "/api/workflows/customer%2Freview/runs",
          "/api/workflow-runs",
          "/api/workflow-runs/workflow%2Frun-1",
        ])
        expect(api.requests[0]?.url.searchParams.get("objectTypeId")).toBe("Customer")
        expect(api.requests[0]?.url.searchParams.get("limit")).toBe("20")
        expect(api.requests[1]?.url.searchParams.get("q")).toBe("north line")
        expect(api.requests[2]?.body).toEqual({
          query: { kind: "start", objectTypeId: "Customer" },
          includeTotal: true,
        })
        expect(api.requests[11]?.body).toEqual({
          params: { value: "sent" },
          subject: { kind: "object", objectTypeId: "Customer", primaryId: "customer/1" },
          runId: "run-1",
        })
        expect(api.requests[18]?.body).toEqual({ input: { value: "sent" } })
      } finally {
        api.close()
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    test("exposes no raw request, origin, or header override", async () => {
      const api = startGraphApi()
      try {
        const raw = await runCli(implementation, ["api", "get", "/api/project"], apiEnv(api))
        expect(raw.exitCode).toBe(2)
        expect(JSON.parse(raw.stderr)).toEqual({
          error: {
            code: "invalid_arguments",
            message: "Unknown command 'api'. Run 'sixb --help'.",
          },
        })

        const originFlag = await runCli(
          implementation,
          ["project", "show", "--origin", "https://attacker.invalid"],
          apiEnv(api)
        )
        expect(originFlag.exitCode).toBe(2)

        const headerFlag = await runCli(
          implementation,
          ["project", "show", "--header", "Authorization: secret"],
          apiEnv(api)
        )
        expect(headerFlag.exitCode).toBe(2)
        expect(api.requests).toHaveLength(0)
      } finally {
        api.close()
      }
    })
  })
}

async function runCli(
  implementation: AgentCliContractImplementation,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
): Promise<CliResult> {
  return runCommand([...implementation.command, ...args], env)
}

async function runCommand(
  command: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [...command],
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function startGraphApi(): TestApi {
  return startTestApi((request) => {
    if (request.method === "GET" && request.url.pathname === "/api/project") {
      return json({ id: "contract-project", name: "Contract project" })
    }
    if (request.method === "GET" && request.url.pathname === "/api/object-types") {
      return json(objectTypes)
    }
    if (request.method === "GET" && request.url.pathname.startsWith("/api/object-types/")) {
      const objectTypeId = decodeURIComponent(
        request.url.pathname.slice("/api/object-types/".length)
      )
      const definition = objectTypes.find((value) => value.id === objectTypeId)
      return definition ? json(definition) : json({ error: "Object type not found" }, 404)
    }
    if (request.method === "POST" && request.url.pathname === "/api/objects/query") {
      const body = asRecord(request.body)
      const query = asRecord(body.query)
      const refs = query.kind === "refs" ? asRecords(query.refs) : []
      return json({
        objects: refs.flatMap((ref) => {
          const row = findObject(String(ref.objectTypeId), String(ref.primaryId))
          return row ? [row] : []
        }),
        hasMore: false,
        plan: { mode: "pushdown", steps: [] },
      })
    }
    if (request.method === "POST" && request.url.pathname === "/api/objects/query/links") {
      const body = asRecord(request.body)
      const query = asRecord(body.query)
      const refs = query.kind === "refs" ? asRecords(query.refs) : []
      const selected = new Set(
        refs.map((ref) => identity(String(ref.objectTypeId), String(ref.primaryId)))
      )
      const direction = String(body.direction ?? "both")
      const linkId = typeof body.linkId === "string" ? body.linkId : undefined
      const incident = links.filter((link) => {
        const outgoing = selected.has(identity(link.source.objectTypeId, link.source.primaryId))
        const incoming = selected.has(identity(link.target.objectTypeId, link.target.primaryId))
        const matchesDirection =
          direction === "outgoing"
            ? outgoing
            : direction === "incoming"
              ? incoming
              : outgoing || incoming
        return matchesDirection && (linkId === undefined || link.linkId === linkId)
      })
      const responseObjects = new Map<string, (typeof objects)[number]>()
      if (body.includeObjects === true) {
        for (const ref of refs) {
          const row = findObject(String(ref.objectTypeId), String(ref.primaryId))
          if (row) responseObjects.set(identity(row.objectTypeId, row.primaryId), row)
        }
        for (const link of incident) {
          for (const ref of [link.source, link.target]) {
            const row = findObject(ref.objectTypeId, ref.primaryId)
            if (row) responseObjects.set(identity(row.objectTypeId, row.primaryId), row)
          }
        }
      }
      return json({ objects: [...responseObjects.values()], links: incident, hasMore: false })
    }
  })
}

function startTestApi(handler: TestApiHandler): TestApi {
  const requests: RecordedRequest[] = []
  const fetch = async (request: Request): Promise<Response> => {
    const contentType = request.headers.get("content-type") ?? ""
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : contentType.includes("application/json")
          ? await request.json()
          : await request.text()
    const recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: new Headers(request.headers),
      body,
    }
    requests.push(recorded)
    return (await handler(recorded)) ?? json({ error: "Unexpected contract request" }, 404)
  }
  let server: ReturnType<typeof Bun.serve> | undefined
  for (let attempt = 0; attempt < 100 && !server; attempt += 1) {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: nextTestPort++, fetch })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error
    }
  }
  if (!server) throw new Error("Could not allocate a local port for the agent CLI contract.")
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    close: () => server.stop(true),
  }
}

function apiEnv(api: TestApi): Readonly<Record<string, string>> {
  return { SIXB_API_BASE_URL: api.baseUrl }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function object(objectTypeId: string, primaryId: string, properties: Record<string, unknown>) {
  return {
    objectTypeId,
    primaryId,
    properties,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  }
}

function edge(
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string
) {
  return {
    source: { objectTypeId: sourceTypeId, primaryId: sourceId },
    linkId,
    target: { objectTypeId: targetTypeId, primaryId: targetId },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  }
}

function identity(objectTypeId: string, primaryId: string): string {
  return JSON.stringify([objectTypeId, primaryId])
}

function findObject(objectTypeId: string, primaryId: string) {
  return objects.find(
    (value) => value.objectTypeId === objectTypeId && value.primaryId === primaryId
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}
