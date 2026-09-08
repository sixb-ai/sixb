import { access } from "node:fs/promises"
import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp, requireExact } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"

export async function files(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.files)
  if (sub === "upload") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--logical-path": "string" },
      "files upload",
      1
    )
    const source = positionals[0] ?? ""
    try {
      await access(source)
    } catch {
      fail(`Upload file '${source}' does not exist.`)
    }
    return writeJson(await api.upload("/api/files", source, options["--logical-path"]))
  }
  if (sub === "download") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--path": "string", "--output": "string" },
      "files download",
      [2, 3]
    )
    const context = positionals[0]
    let route: string
    if (context === "object") {
      requireExact(positionals, 3, "files download object requires object type and primary id.")
      const type = positionals[1] ?? ""
      const id = positionals[2] ?? ""
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`
    } else if (context === "action-run" || context === "workflow-run") {
      requireExact(positionals, 2, `files download ${context} requires exactly one run id.`)
      const id = positionals[1] ?? ""
      route = `/api/${context}s/${encodeURIComponent(id)}/files/content`
    } else fail(`Unknown file download context '${context}'.`)
    const path = options["--path"]
    const output = options["--output"]
    if (!path) fail("files download requires --path <json-pointer>.")
    if (!output) fail("files download requires --output <local-path>.")
    await api.download(route, output, { path })
    return writeJson({ downloaded: true, output })
  }
  fail(`Unknown files command '${sub}'.`)
}
