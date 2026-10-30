import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
import { prepareAgentSandboxApiContext } from "../src/sandbox-api-context"
import { LocalBashSandbox } from "./helpers"

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("installing a conversation's artifacts", () => {
  // Guard proof: drop the `rm -rf` of the artifacts directory from prepareAgentSandboxApiContext;
  // the file only the earlier version had is still there.
  test("leaves nothing an earlier run installed in a persistent workspace", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-artifacts-install-")))
    const copy = join(root, ".sixb/agent/artifacts/art_0000000001")
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, "figure-from-v1.svg"), "<svg/>")

    await prepareAgentSandboxApiContext({
      sandbox: new LocalBashSandbox(root),
      contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
      runToken: "sixb_run_v1_test",
      apiBaseUrl: "http://gateway.invalid",
      projectId: "artifacts-install",
      runId: "run_1",
      skills: [],
      ontologyFiles: [],
      artifacts: {
        manifestJson: JSON.stringify({ artifacts: [] }),
        files: [
          {
            path: ".sixb/agent/artifacts/art_0000000001/document.md",
            contents: new TextEncoder().encode("# Version 2\n"),
          },
        ],
      },
    })

    expect(existsSync(join(copy, "figure-from-v1.svg"))).toBe(false)
    expect(readFileSync(join(copy, "document.md"), "utf8")).toBe("# Version 2\n")
  })
})

describe("the run's context directory", () => {
  // Guard proof: join `.sixb/agent` to the working directory in prepareAgentSandboxApiContext, as
  // before; the files land in the working directory and the env names them there.
  test("holds every run file, even outside the working directory", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-context-directory-")))
    const workingDirectory = join(root, "folder")
    const contextDirectory = join(root, "run_1")
    mkdirSync(workingDirectory)
    const attachment = new TextEncoder().encode("Net 30\n")

    const { env } = await prepareAgentSandboxApiContext({
      sandbox: new LocalBashSandbox(workingDirectory),
      contextDirectory,
      runToken: "sixb_run_v1_test",
      apiBaseUrl: "http://gateway.invalid",
      projectId: "context-directory",
      runId: "run_1",
      skills: [
        {
          name: "acme-style",
          description: "Use when drafting customer-facing copy.",
          files: [{ path: "SKILL.md", contents: "# Style\n" }],
        },
      ],
      ontologyFiles: [{ path: "billing/invoice.md", contents: "# Invoice\n" }],
      attachments: {
        entries: [],
        promptTextByPartKey: new Map(),
        modelFileDataByPartKey: new Map(),
        sandboxFiles: [
          {
            key: "message-1:0",
            path: join(contextDirectory, "attachments/message-1/0-terms.md"),
            bytes: attachment,
            fileRef: {
              blobId: "blob_terms",
              digest: "sha256:terms",
              sizeBytes: attachment.byteLength,
            },
          },
        ],
        manifestJson: JSON.stringify({ attachments: [] }),
      },
      artifacts: {
        manifestJson: JSON.stringify({ artifacts: [] }),
        files: [
          {
            path: join(contextDirectory, "artifacts/art_0000000001/document.md"),
            contents: new TextEncoder().encode("# Q3 review\n"),
          },
        ],
      },
      memory: [{ repo: "user", revision: 0, files: [] }],
    })

    expect(readdirSync(workingDirectory)).toEqual([])
    expect(env).toMatchObject({
      SIXB_CONTEXT_DIR: contextDirectory,
      SIXB_SKILLS_DIR: join(contextDirectory, "skills"),
      SIXB_ONTOLOGY_DIR: join(contextDirectory, "ontology"),
      SIXB_BIN_DIR: join(contextDirectory, "bin"),
      BASH_ENV: join(contextDirectory, "context/bash-env"),
      SIXB_RUN_CONTEXT: join(contextDirectory, "context/run.json"),
      SIXB_ATTACHMENTS: join(contextDirectory, "context/attachments.json"),
      SIXB_ATTACHMENT_DIR: join(contextDirectory, "attachments"),
      SIXB_ARTIFACTS: join(contextDirectory, "context/artifacts.json"),
      SIXB_ARTIFACTS_DIR: join(contextDirectory, "artifacts"),
      SIXB_MEMORY_DIR: join(contextDirectory, "memory"),
    })
    for (const path of [
      "skills/acme-style/SKILL.md",
      "ontology/billing/invoice.md",
      "bin/sixb",
      "lib/sixb.mjs",
      "context/run.json",
      "context/attachments.json",
      "context/artifacts.json",
      "attachments/message-1/0-terms.md",
      "artifacts/art_0000000001/document.md",
      "memory/user/MEMORY.md",
    ]) {
      expect(existsSync(join(contextDirectory, path)), path).toBe(true)
    }
  })
})

describe("the run's API access", () => {
  // Guard proof: give commands SIXB_TOKEN whatever the sandbox; the token shows up below.
  test("a sandbox that adds the run token gives commands its address, never the token", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-api-access-")))
    const sandbox = Object.assign(new LocalBashSandbox(root), {
      credentialedUrl: (url: string) => `unix:/tmp/forwarder.sock#${url}`,
    })

    const { env } = await prepareAgentSandboxApiContext({
      sandbox,
      contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
      apiBaseUrl: "http://api.example.test",
      runToken: "sixb_run_v1_secret",
      projectId: "api-access",
      runId: "run_1",
      skills: [],
      ontologyFiles: [],
    })

    expect(env.SIXB_API_BASE_URL).toBe("unix:/tmp/forwarder.sock#http://api.example.test")
    expect(env).not.toHaveProperty("SIXB_TOKEN")
    expect(JSON.stringify(env)).not.toContain("sixb_run_v1_secret")
    const runContext = readFileSync(
      join(root, SANDBOX_CONTEXT_DIRECTORY, "context/run.json"),
      "utf8"
    )
    expect(JSON.parse(runContext).apiBaseUrl).toBe(env.SIXB_API_BASE_URL)
    expect(runContext).not.toContain("sixb_run_v1_secret")
  })
})
