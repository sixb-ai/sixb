import { describe, expect, test } from "bun:test"
import {
  classifyCommand,
  coerceBashOutput,
  describeBash,
  humanize,
  objectCount,
} from "../src/bash/interpret"

function output(stdout: string, exitCode = 0) {
  return coerceBashOutput({
    exitCode,
    stdout,
    stderr: "",
    durationMs: 35,
    stdoutTruncated: false,
    stderrTruncated: false,
  })
}

describe("classifyCommand", () => {
  test("classifies the ontology discovery curl", () => {
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/object-types"`)).toEqual({
      kind: "api-object-types",
    })
  })

  test("classifies a single object type detail", () => {
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/object-types/customer"`)).toEqual({
      kind: "api-object-type-detail",
      objectTypeId: "customer",
    })
  })

  test("reads the objectTypeId from a GET objects list query string", () => {
    expect(
      classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/objects?objectTypeId=customer&limit=20"`)
    ).toEqual({ kind: "api-objects-list", objectTypeId: "customer" })
  })

  test("reads the objectTypeId from a nested POST query body", () => {
    const command = `curl -sS -H "Content-Type: application/json" -X POST "$SIXB_API_BASE_URL/api/objects/query" --data '{"query":{"kind":"filter","input":{"kind":"start","objectTypeId":"workOrder"},"predicate":{"kind":"eq","propertyId":"status","value":"open"}}}'`
    expect(classifyCommand(command)).toEqual({
      kind: "api-objects-query",
      objectTypeId: "workOrder",
    })
  })

  test("distinguishes count, exists, and facets", () => {
    const base = (suffix: string) =>
      `curl -sS -X POST "$SIXB_API_BASE_URL/api/objects/query/${suffix}" --data '{"query":{"kind":"start","objectTypeId":"customer"}}'`
    expect(classifyCommand(base("count")).kind).toBe("api-count")
    expect(classifyCommand(base("exists")).kind).toBe("api-exists")
    expect(classifyCommand(base("facets")).kind).toBe("api-facets")
  })

  test("classifies object detail and telemetry reads", () => {
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/objects/customer/cust-001"`)).toEqual({
      kind: "api-object-detail",
      objectTypeId: "customer",
      objectId: "cust-001",
    })
    expect(
      classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/latest"`)
    ).toEqual({ kind: "api-telemetry-latest", objectId: "fan-1", propertyId: "rpm" })
    expect(
      classifyCommand(
        `curl -sS "$SIXB_API_BASE_URL/api/objects/device/fan-1/telemetry/rpm/history?limit=100"`
      )
    ).toEqual({ kind: "api-telemetry-history", objectId: "fan-1", propertyId: "rpm" })
  })

  test("classifies bulk telemetry at the top-level route", () => {
    expect(
      classifyCommand(
        `curl -sS -X POST "$SIXB_API_BASE_URL/api/telemetry/history" --data '{"series":[]}'`
      )
    ).toEqual({ kind: "api-telemetry-bulk" })
  })

  test("classifies actions list versus action request", () => {
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/actions"`).kind).toBe(
      "api-actions-list"
    )
    expect(
      classifyCommand(
        `curl -sS -X POST "$SIXB_API_BASE_URL/api/actions/archiveCustomer" --data '{}'`
      )
    ).toEqual({ kind: "api-action-request", actionId: "archiveCustomer" })
  })

  test("treats a curl with a body flag but no -X as an implicit POST", () => {
    // No `-X POST`: curl still POSTs because `-d` is present. Without the inference this would
    // default to GET and be mislabelled as an actions list rather than an action request.
    expect(
      classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/actions/archiveCustomer" -d '{}'`)
    ).toEqual({ kind: "api-action-request", actionId: "archiveCustomer" })
    expect(
      classifyCommand(
        `curl -sS "$SIXB_API_BASE_URL/api/actions/archiveCustomer" --data-raw '{"reason":"x"}'`
      )
    ).toEqual({ kind: "api-action-request", actionId: "archiveCustomer" })
    // --data-urlencode is a real curl body flag, so it implies POST too.
    expect(
      classifyCommand(
        `curl -sS "$SIXB_API_BASE_URL/api/actions/archiveCustomer" --data-urlencode 'reason=x'`
      ).kind
    ).toBe("api-action-request")
  })

  test("does not infer POST from a body flag that only appears inside a quoted argument", () => {
    // The `--data` here is inside a header value, not a real curl flag: method stays GET, so this
    // is an actions list — not an action request. Guards the quote-blanking in the method detector.
    expect(
      classifyCommand(
        `curl -sS "$SIXB_API_BASE_URL/api/actions/archiveCustomer" -H "X-Note: --data disabled"`
      ).kind
    ).toBe("api-actions-list")
  })

  test("keeps an explicit method even when a body flag is present", () => {
    // `-X GET` must win over the implicit-POST inference triggered by `-d`.
    expect(
      classifyCommand(`curl -sS -X GET "$SIXB_API_BASE_URL/api/actions/archiveCustomer" -d '{}'`)
        .kind
    ).toBe("api-actions-list")
  })

  test("classifies an action run lookup", () => {
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/action-runs/run-abc123"`)).toEqual({
      kind: "api-action-run",
      runId: "run-abc123",
    })
  })

  test("classifies a skill read with skill name and reference", () => {
    expect(classifyCommand(`cat "$SIXB_SKILLS_DIR/sixb-query/SKILL.md"`)).toEqual({
      kind: "read-skill",
      skillName: "sixb-query",
      reference: undefined,
    })
    expect(
      classifyCommand(`cat /tmp/sandbox/.sixb/agent/skills/sixb-query/references/query-api.md`)
    ).toEqual({ kind: "read-skill", skillName: "sixb-query", reference: "query-api.md" })
  })

  test("a skill-path read is not mistaken for an API call", () => {
    // The string contains "query-api" but never "/api/" — must stay a skill read.
    expect(classifyCommand(`cat skills/sixb-query/references/query-api.md`).kind).toBe("read-skill")
  })

  test("falls back to generic for plain shell commands", () => {
    expect(classifyCommand("ls -la /workspace")).toEqual({
      kind: "generic",
      command: "ls -la /workspace",
    })
  })
})

describe("describeBash", () => {
  test("summarizes the ontology with a count", () => {
    const parsed = output(`[{"id":"Customer"},{"id":"Project"},{"id":"Invoice"}]`)
    const description = describeBash({ kind: "api-object-types" }, parsed)
    expect(description.title).toBe("Explored the ontology")
    expect(description.detail).toBe("3 object types")
  })

  test("summarizes a query result count with a humanized type label", () => {
    const parsed = output(`{"objects":[{"primaryId":"a"},{"primaryId":"b"}],"hasMore":false}`)
    const description = describeBash(
      { kind: "api-objects-query", objectTypeId: "workOrder" },
      parsed
    )
    expect(description.title).toBe("Found 2 work orders")
  })

  test("summarizes a count response value", () => {
    const description = describeBash(
      { kind: "api-count", objectTypeId: "customer" },
      output(`{"count":142}`)
    )
    expect(description.title).toBe("Counted customers")
    expect(description.detail).toBe("142")
  })

  test("summarizes an action run from its status and subject", () => {
    const json = JSON.stringify({
      actionId: "archiveCustomer",
      status: "succeeded",
      subject: { kind: "object", objectTypeId: "customer", primaryId: "cust-001" },
    })
    const description = describeBash({ kind: "api-action-run", runId: "run-1" }, output(json))
    expect(description.title).toBe("Archive customer succeeded")
    expect(description.detail).toBe("customer cust-001")
  })
})

describe("coerceBashOutput", () => {
  test("decodes JSON stdout on success", () => {
    const parsed = output(`{"count":5}`)
    expect(parsed?.ok).toBe(true)
    expect(parsed?.json).toEqual({ count: 5 })
  })

  test("does not decode JSON when the command failed", () => {
    const parsed = output(`{"count":5}`, 1)
    expect(parsed?.ok).toBe(false)
    expect(parsed?.json).toBeUndefined()
  })

  test("leaves non-JSON stdout undecoded", () => {
    expect(output("plain text output")?.json).toBeUndefined()
  })
})

describe("helpers", () => {
  test("humanize splits camelCase and kebab", () => {
    expect(humanize("workOrder")).toBe("work order")
    expect(humanize("sixb-query")).toBe("sixb query")
  })

  test("objectCount handles both list and query envelopes", () => {
    expect(objectCount([1, 2, 3])).toBe(3)
    expect(objectCount({ objects: [1, 2] })).toBe(2)
    expect(objectCount({ count: 9 })).toBeNull()
  })
})
