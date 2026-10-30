import { expect, test } from "bun:test"
import {
  GUEST_CREDENTIAL_PATHS,
  GUEST_FORWARDER_NOT_RUNNING,
  type SandboxRequestCredential,
} from "@sixb/core/sandboxes"
import type { AzureExecResult, AzureSandboxClient } from "../src/azure-client"
import { installAzureCredentials } from "../src/request-credentials"

const SECRET = "Bearer sixb_run_v1_azure-secret"
const credential: SandboxRequestCredential = {
  origin: "https://api.example.com",
  path: { prefix: "/api/" },
  method: ["GET", "POST"],
  headers: { Authorization: SECRET },
}

/** Records what reaches the guest; answers the install step with `installExit`. */
function recordingClient(installExit: number) {
  const commands: string[] = []
  const files: { path: string; contents: string; mode?: number }[] = []
  const client = {
    execute: async (_id: string, command: string): Promise<AzureExecResult> => {
      commands.push(command)
      const exitCode = command.includes("forwarder.pid") ? installExit : 0
      return { exitCode, stdout: "", stderr: "" }
    },
    writeFile: async (_id: string, path: string, contents: string | Uint8Array, mode?: number) => {
      files.push({ path, contents: String(contents), ...(mode === undefined ? {} : { mode }) })
    },
  } as unknown as AzureSandboxClient
  return { client, commands, files }
}

// Guest commands can read any process's command line, so the credentials travel only through
// the file API, into root-only files.
test("installs credentials through root-only files, never a command line", async () => {
  const { client, commands, files } = recordingClient(GUEST_FORWARDER_NOT_RUNNING)

  await installAzureCredentials(client, "sbx-1", [credential], new AbortController().signal)

  expect(files.map(({ path, mode }) => [path, mode])).toEqual([
    [`${GUEST_CREDENTIAL_PATHS.state}/credentials.json`, 0o600],
    [`${GUEST_CREDENTIAL_PATHS.state}/forwarder.mjs`, 0o600],
  ])
  expect(files[0]?.contents).toContain(SECRET)
  for (const command of commands) expect(command).not.toContain("azure-secret")
  // No forwarder ran yet: it is started in a session of its own, then awaited.
  expect(commands.some((command) => command.startsWith("setsid -f "))).toBe(true)
})

test("a running forwarder reloads instead of starting again", async () => {
  const { client, commands } = recordingClient(0)

  await installAzureCredentials(client, "sbx-1", [credential], new AbortController().signal)

  expect(commands.some((command) => command.startsWith("setsid -f "))).toBe(false)
})
