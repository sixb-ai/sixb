import { describe, expect, test } from "bun:test"
import {
  type BashIntent,
  classifyCommand,
  coerceBashOutput,
  commandPreview,
  describeBash,
  modelMedia,
} from "../src/agent/bash/interpret"

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
      "sixb models list --kind image": "models.list",
      "sixb models get bfl/flux-3-image-klein": "models.get",
      'sixb models text "Status?"': "models.text",
      'sixb models image "a van" --output out/van.png': "models.image",
      'sixb models speech "Hello." --output out/hello.mp3': "models.speech",
      "sixb models transcribe call.m4a": "models.transcribe",
      "sixb models calls files call_1": "models.calls",
      "sixb api get /api/project": "api.get",
      "sixb api post /api/custom --file body.json": "api.post",
    } as const

    for (const [command, expected] of Object.entries(cases)) {
      const intent = classifyCommand(command)
      expect(intent.kind).toBe("sixb")
      if (intent.kind === "sixb") expect(intent.command).toBe(expected)
    }
  })

  test.each<[string, string, BashIntent]>([
    [
      "tokenizes quoted opaque object ids without interpreting their path characters",
      `sixb objects get RepositoryIssue 'github:issue:sixb-ai/sixb#297'`,
      {
        kind: "sixb",
        command: "objects.get",
        args: ["RepositoryIssue", "github:issue:sixb-ai/sixb#297"],
      },
    ],
    [
      "recognizes an installed CLI by basename",
      "/opt/sixb/bin/sixb ontology list",
      { kind: "sixb", command: "ontology.list", args: [] },
    ],
    [
      "recognizes CLI commands after ordinary environment setup",
      "SIXB_DEBUG=1 sixb ontology list",
      { kind: "sixb", command: "ontology.list", args: [] },
    ],
    [
      "recognizes CLI commands after env",
      "env SIXB_DEBUG=1 sixb objects list --type Customer",
      { kind: "sixb", command: "objects.list", args: ["--type", "Customer"] },
    ],
    [
      "separates help from query execution",
      "sixb objects query --help",
      { kind: "sixb", command: "help", args: ["objects", "query"] },
    ],
    [
      "separates copyable query examples from query execution",
      "sixb objects query --example incoming",
      { kind: "sixb", command: "objects.query-example", args: ["--example", "incoming"] },
    ],
    [
      "treats help as an argument outside command positions",
      "sixb objects get Customer help",
      { kind: "sixb", command: "objects.get", args: ["Customer", "help"] },
    ],
    [
      "treats help as an option value outside command positions",
      "sixb objects query --file help",
      { kind: "sixb", command: "objects.query", args: ["--file", "help"] },
    ],
    [
      "keeps unknown Sixb operations recognizable without guessing their meaning",
      "sixb objects future --value x",
      { kind: "sixb", command: "unknown", args: ["objects", "future", "--value", "x"] },
    ],
    [
      "classifies a skill read with its skill name",
      `cat "$SIXB_SKILLS_DIR/sixb/SKILL.md"`,
      { kind: "read-skill", skillName: "sixb", reference: undefined },
    ],
    [
      "classifies a skill read with its reference",
      "cat /tmp/sandbox/.sixb/agent/skills/sixb/references/query-ir.md",
      { kind: "read-skill", skillName: "sixb", reference: "query-ir.md" },
    ],
    [
      "classifies a relative skill-path read",
      "cat skills/sixb/references/query-ir.md",
      { kind: "read-skill", skillName: "sixb", reference: "query-ir.md" },
    ],
    [
      "does not mistake a skill path in an argument for a skill read",
      "echo cat skills/sixb/references/query-ir.md",
      { kind: "generic", command: "echo cat skills/sixb/references/query-ir.md" },
    ],
    [
      "falls back to generic for plain commands",
      "ls -la /workspace",
      { kind: "generic", command: "ls -la /workspace" },
    ],
    [
      "falls back to generic for legacy curl commands",
      `curl -sS "$SIXB_API_BASE_URL/api/object-types"`,
      { kind: "generic", command: `curl -sS "$SIXB_API_BASE_URL/api/object-types"` },
    ],
    [
      "keeps the meaningful intent when commands are combined",
      "sixb ontology list | jq .",
      {
        kind: "compound",
        primary: { kind: "sixb", command: "ontology.list", args: [] },
        stepCount: 2,
      },
    ],
    [
      "does not split operators inside quotes",
      `echo "one && two"`,
      { kind: "generic", command: `echo "one && two"` },
    ],
    [
      "does not split operators inside heredocs",
      `cat > output.html <<'HTML'\n<script>ready && render()</script>\nHTML`,
      {
        kind: "generic",
        command: `cat > output.html <<'HTML'\n<script>ready && render()</script>\nHTML`,
      },
    ],
  ])("%s", (_reason, command, expected) => {
    expect(classifyCommand(command)).toEqual(expected)
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

  test("keeps an unknown generic command out of the collapsed activity line", () => {
    const description = describeBash({ kind: "generic", command: "uname -a" }, output("files"))

    expect(description.title).toBe("Ran a command")
    expect(description.runningTitle).toBe("Running a command")
    expect(description.detail).toBeUndefined()
  })

  test("describes a generated file by intent instead of exposing its payload", () => {
    const html = describeBash(
      classifyCommand(
        `cat > "$SIXB_OUTPUT_PATH" <<'HTML'\n<!DOCTYPE html>\n<html>\n<body>Hi</body>\n</html>\nHTML`
      ),
      null
    )
    expect(html.title).toBe("Created an HTML file")
    expect(html.runningTitle).toBe("Creating an HTML file")
    expect(html.detail).toBeUndefined()
  })

  test.each([
    // Combined commands keep the meaningful step, including a fallback branch.
    ["cd packages/core && bun test tests", "Running tests"],
    ["bun test || echo failed", "Running tests"],
    ["uname -a && date", "Running 2 steps"],
    ["find packages | head -n 20", "Inspecting files"],
    // Operators inside quotes and heredocs do not split the command.
    [`printf '%s' 'one && two' && pwd`, "Checking the workspace location"],
    [
      `cat > output.html <<'HTML'\n<script>ready && render()</script>\nHTML`,
      "Creating an HTML file",
    ],
    // Common generic commands are described by intent.
    ["bun test packages/core/tests", "Running tests"],
    ["rg -n Customer packages", "Searching files"],
    ["ls -la /workspace", "Inspecting files"],
    ["find packages -name '*.ts'", "Inspecting files"],
    ["pwd", "Checking the workspace location"],
    ["head -n 20 README.md", "Reading a file"],
    ["TEST_MODE=1 bun test", "Running tests"],
    // Generic commands are classified by executable, not by words in their arguments.
    ["echo bun test", "Running a command"],
    ["echo ls packages", "Running a command"],
    ["echo head README.md", "Running a command"],
    [`echo "cat > report.txt"`, "Running a command"],
    ["(bun test || true)", "Running a command"],
  ])("describes `%s` as %s", (command, runningTitle) => {
    expect(describeBash(classifyCommand(command), null).runningTitle).toBe(runningTitle)
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
    // Both the list and the query envelopes are counted; a response without objects is not.
    const list = { kind: "sixb", command: "objects.list", args: ["--type", "workOrder"] } as const
    expect(describeBash(list, output(`[{},{},{}]`)).title).toBe("Found 3 work orders")
    expect(describeBash(list, output(`{"count":9}`)).title).toBe("Queried objects")
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

  test("summarizes a requested action from the finished run it returns", () => {
    const intent = { kind: "sixb", command: "actions.request", args: ["archiveCustomer"] } as const
    const run = (status: string) =>
      output(
        JSON.stringify({
          actionId: "archiveCustomer",
          status,
          subject: { kind: "object", objectTypeId: "customer", primaryId: "cust-001" },
        })
      )

    expect(describeBash(intent, run("succeeded"))).toMatchObject({
      title: "Archive customer succeeded",
      runningTitle: "Running the archive customer action",
      detail: "customer cust-001",
    })
    expect(describeBash(intent, run("failed")).title).toBe("Archive customer failed")
    expect(describeBash(intent, output("not json")).title).toBe("Ran the archive customer action")
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
  test("decodes JSON stdout only when the command succeeded", () => {
    expect(output(`{"count":5}`)).toMatchObject({ ok: true, json: { count: 5 } })
    const failed = output(`{"count":5}`, 1)
    expect(failed?.ok).toBe(false)
    expect(failed?.json).toBeUndefined()
    expect(output("plain text output")?.json).toBeUndefined()
  })
})

describe("helpers", () => {
  test("folds multiline command payloads into a stable first-line preview", () => {
    const preview = commandPreview(
      "cat > output.html <<'HTML'\n<html>\n<body>large</body>\n</html>"
    )
    expect(preview).toBe("cat > output.html <<'HTML'\n… 3 more lines")
    expect(preview).not.toContain("large")
  })
})

describe("model calls", () => {
  // Removal proof: drop the models group from CLI_COMMANDS; these read as an unknown Sixb command.
  test.each([
    ['sixb models image "a van" --output out/van.png', "Made an image", "Making an image"],
    ['sixb models image "a van" --n 2 --output out/', "Made 2 images", "Making 2 images"],
    [
      'sixb models image "make it blue" --image photos/site.png --output out/blue.png',
      "Edited an image",
      "Editing an image",
    ],
    [
      'sixb models speech "Hello." --output out/hello.mp3',
      "Created a voice clip",
      "Creating a voice clip",
    ],
    ["sixb models transcribe calls/dispatch.m4a", "Transcribed audio", "Transcribing audio"],
    ['sixb models text "Status?"', "Asked another model", "Asking another model"],
    ["sixb models list", "Checked the available models", "Checking the available models"],
  ])("describes `%s` by what it makes", (command, title, runningTitle) => {
    const description = describeBash(classifyCommand(command), null)
    expect([description.title, description.runningTitle]).toEqual([title, runningTitle])
  })

  test("reads what a call takes and makes, not which model made it", () => {
    const image = modelMedia(
      classifyCommand(
        'mkdir -p out && sixb models image "make it blue" --model google/gemini --image photos/site.png --aspect-ratio 16:9 --output out/blue.png'
      ),
      output(JSON.stringify({ callId: "call_1", model: "google/gemini", files: ["out/blue.jpg"] }))
    )
    expect(image).toEqual({
      kind: "image",
      prompt: "make it blue",
      sources: ["site.png"],
      count: 1,
      aspect: 16 / 9,
      callId: "call_1",
      files: ["blue.jpg"],
    })
    expect(
      modelMedia(classifyCommand('sixb models image "tall" --size 1024x1536 --output a.png'), null)
    ).toMatchObject({ aspect: 1024 / 1536 })
    expect(
      modelMedia(
        classifyCommand("sixb models transcribe calls/dispatch.m4a"),
        output(JSON.stringify({ callId: "call_2", text: "Running late." }))
      )
    ).toEqual({
      kind: "transcript",
      source: "dispatch.m4a",
      text: "Running late.",
      callId: "call_2",
    })
    expect(modelMedia(classifyCommand("sixb objects list --type Customer"), null)).toBeNull()
  })
})
