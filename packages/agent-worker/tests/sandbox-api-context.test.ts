import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
