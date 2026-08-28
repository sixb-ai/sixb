import { describe, expect, test } from "bun:test"
import {
  classifyCommand,
  coerceBashOutput,
  commandPreview,
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
  test("classifies every supported CLI operation from its fixed command path", () => {
    const cases = {
      "sixb doctor": "doctor",
      "sixb context": "context",
      "sixb project show": "project.show",
      "sixb ontology list": "ontology.list",
      "sixb ontology get Customer": "ontology.get",
      "sixb objects inspect Customer cust-1": "objects.inspect",
      "sixb objects list --type Customer": "objects.list",
      "sixb objects get Customer cust-1": "objects.get",
      "sixb objects search acme": "objects.search",
      "sixb objects query --file query.json": "objects.query",
      "sixb objects count --file query.json": "objects.count",
      "sixb objects exists --file query.json": "objects.exists",
      "sixb objects facets --file query.json": "objects.facets",
      "sixb objects links Customer cust-1": "objects.links",
      "sixb telemetry latest Device fan-1 rpm": "telemetry.latest",
      "sixb telemetry history Device fan-1 rpm": "telemetry.history",
      "sixb telemetry query --file telemetry.json": "telemetry.query",
      "sixb actions list": "actions.list",
      "sixb actions get archiveCustomer": "actions.get",
      "sixb actions request archiveCustomer": "actions.request",
      "sixb action-runs list": "action-runs.list",
      "sixb action-runs get run-1": "action-runs.get",
      "sixb files upload report.pdf": "files.upload",
      "sixb files download action-run run-1 --path /result --output result.json": "files.download",
      "sixb workflows list": "workflows.list",
      "sixb workflows get renewCustomer": "workflows.get",
      "sixb workflows start renewCustomer": "workflows.start",
      "sixb workflow-runs list": "workflow-runs.list",
      "sixb workflow-runs get run-2": "workflow-runs.get",
      "sixb api get /api/project": "api.get",
      "sixb api post /api/custom --file body.json": "api.post",
    } as const

    for (const [command, expected] of Object.entries(cases)) {
      const intent = classifyCommand(command)
      expect(intent.kind).toBe("sixb")
      if (intent.kind === "sixb") expect(intent.command).toBe(expected)
    }
  })

  test("tokenizes quoted opaque object ids without interpreting their path characters", () => {
    expect(
      classifyCommand(`sixb objects get RepositoryIssue 'github:issue:sixb-ai/sixb#297'`)
    ).toEqual({
      kind: "sixb",
      command: "objects.get",
      args: ["RepositoryIssue", "github:issue:sixb-ai/sixb#297"],
    })
  })

  test("recognizes an installed CLI by basename", () => {
    expect(classifyCommand("/opt/sixb/bin/sixb ontology list")).toEqual({
      kind: "sixb",
      command: "ontology.list",
      args: [],
    })
  })

  test("separates help and copyable query examples from query execution", () => {
    expect(classifyCommand("sixb objects query --help")).toEqual({
      kind: "sixb",
      command: "help",
      args: ["objects", "query"],
    })
    expect(classifyCommand("sixb objects query --example incoming")).toEqual({
      kind: "sixb",
      command: "objects.query-example",
      args: ["--example", "incoming"],
    })
  })

  test("keeps unknown Sixb operations recognizable without guessing their meaning", () => {
    expect(classifyCommand("sixb objects future --value x")).toEqual({
      kind: "sixb",
      command: "unknown",
      args: ["objects", "future", "--value", "x"],
    })
  })

  test("classifies a skill read with skill name and reference", () => {
    expect(classifyCommand(`cat "$SIXB_SKILLS_DIR/sixb/SKILL.md"`)).toEqual({
      kind: "read-skill",
      skillName: "sixb",
      reference: undefined,
    })
    expect(
      classifyCommand(`cat /tmp/sandbox/.sixb/agent/skills/sixb/references/query-ir.md`)
    ).toEqual({ kind: "read-skill", skillName: "sixb", reference: "query-ir.md" })
  })

  test("a skill-path read is not mistaken for a Sixb command", () => {
    expect(classifyCommand(`cat skills/sixb/references/query-ir.md`).kind).toBe("read-skill")
  })

  test("falls back to generic for plain, compound, and legacy curl commands", () => {
    expect(classifyCommand("ls -la /workspace")).toEqual({
      kind: "generic",
      command: "ls -la /workspace",
    })
    expect(classifyCommand("sixb ontology list | jq .").kind).toBe("generic")
    expect(classifyCommand(`curl -sS "$SIXB_API_BASE_URL/api/object-types"`).kind).toBe("generic")
  })
})

describe("describeBash", () => {
  test("describes help as checking project capabilities without CLI terminology", () => {
    const root = describeBash({ kind: "sixb", command: "help", args: [] }, null)
    const objects = describeBash(
      { kind: "sixb", command: "help", args: ["objects", "query"] },
      null
    )

    expect(root.title).toBe("Checked available project operations")
    expect(root.runningTitle).toBe("Checking available project operations")
    expect(objects.title).toBe("Checked how to work with project data")
    expect(objects.runningTitle).toBe("Checking how to work with project data")
    expect(`${root.title} ${objects.title}`).not.toContain("CLI")
  })

  test("puts a generic command directly after the activity verb", () => {
    const description = describeBash(
      { kind: "generic", command: "ls -la /workspace" },
      output("files")
    )

    expect(description.title).toBe("Ran")
    expect(description.runningTitle).toBe("Running a command")
    expect(description.detail).toBe("ls -la /workspace")
  })

  test("describes common generic commands by intent instead of exposing their payload", () => {
    const html = describeBash(
      classifyCommand(
        `cat > "$SIXB_OUTPUT_PATH" <<'HTML'\n<!DOCTYPE html>\n<html>\n<body>Hi</body>\n</html>\nHTML`
      ),
      null
    )
    expect(html.title).toBe("Created an HTML file")
    expect(html.runningTitle).toBe("Creating an HTML file")
    expect(html.detail).toBeUndefined()

    expect(describeBash(classifyCommand("bun test packages/core/tests"), null).runningTitle).toBe(
      "Running tests"
    )
    expect(describeBash(classifyCommand("rg -n Customer packages"), null).runningTitle).toBe(
      "Searching files"
    )
  })

  test("summarizes the ontology with a count", () => {
    const parsed = output(`[{"id":"Customer"},{"id":"Project"},{"id":"Invoice"}]`)
    const description = describeBash({ kind: "sixb", command: "ontology.list", args: [] }, parsed)
    expect(description.title).toBe("Explored the ontology")
    expect(description.detail).toBe("3 object types")
  })

  test("summarizes a query result count with a humanized type label", () => {
    const parsed = output(`{"objects":[{"primaryId":"a"},{"primaryId":"b"}],"hasMore":false}`)
    const description = describeBash(
      { kind: "sixb", command: "objects.get", args: ["workOrder", "a", "b"] },
      parsed
    )
    expect(description.title).toBe("Found 2 work orders")
  })

  test("summarizes a count response value", () => {
    const description = describeBash(
      { kind: "sixb", command: "objects.count", args: ["--file", "query.json"] },
      output(`{"count":142}`)
    )
    expect(description.title).toBe("Counted objects")
    expect(description.detail).toBe("142")
  })

  test("summarizes an action run from its status and subject", () => {
    const json = JSON.stringify({
      actionId: "archiveCustomer",
      status: "succeeded",
      subject: { kind: "object", objectTypeId: "customer", primaryId: "cust-001" },
    })
    const description = describeBash(
      { kind: "sixb", command: "action-runs.get", args: ["run-1"] },
      output(json)
    )
    expect(description.title).toBe("Archive customer succeeded")
    expect(description.detail).toBe("customer cust-001")
  })

  test("summarizes an object inspection graph", () => {
    const description = describeBash(
      {
        kind: "sixb",
        command: "objects.inspect",
        args: ["Customer", "github:customer:acme/1#owner"],
      },
      output(`{"graph":{"objectCount":4,"linkCount":3}}`)
    )
    expect(description.title).toBe("Inspected github:customer:acme/1#owner")
    expect(description.detail).toBe("4 objects · 3 links")
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

  test("folds multiline command payloads into a stable first-line preview", () => {
    const preview = commandPreview(
      "cat > output.html <<'HTML'\n<html>\n<body>large</body>\n</html>"
    )
    expect(preview).toBe("cat > output.html <<'HTML'\n… 3 more lines")
    expect(preview).not.toContain("large")
  })
})
