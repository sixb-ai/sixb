import { access } from "node:fs/promises"
import { ApiClient } from "../api-client"
import { isHelp, requireExact, requireValue } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { parseQueryOptions } from "./shared"

export async function files(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.files)
  const api = new ApiClient()
  if (sub === "upload") {
    const source = requireValue("files upload", rest[0])
    try {
      await access(source)
    } catch {
      fail(`Upload file '${source}' does not exist.`)
    }
    let logicalPath: string | undefined
    if (rest.length > 1) {
      if (rest[1] !== "--logical-path") fail(`Unknown files upload option '${rest[1]}'.`)
      logicalPath = requireValue("--logical-path", rest[2])
      requireExact(rest, 3, "files upload accepts only --logical-path <path>.")
    }
    return writeJson(await api.upload("/api/files", source, logicalPath))
  }
  if (sub === "download") {
    const context = requireValue("files download", rest[0])
    let route: string
    let optionsStart: number
    if (context === "object") {
      const type = requireValue("files download object", rest[1])
      const id = requireValue("files download object", rest[2])
      route = `/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/files/content`
      optionsStart = 3
    } else if (context === "action-run" || context === "workflow-run") {
      const id = requireValue(`files download ${context}`, rest[1])
      route = `/api/${context}s/${encodeURIComponent(id)}/files/content`
      optionsStart = 2
    } else fail(`Unknown file download context '${context}'.`)
    const parsed = parseQueryOptions(
      rest.slice(optionsStart),
      { "--path": "path", "--output": "output" },
      "files download"
    )
    if (!parsed.path) fail("files download requires --path <json-pointer>.")
    if (!parsed.output) fail("files download requires --output <local-path>.")
    await api.download(route, parsed.output, { path: parsed.path })
    return writeJson({ downloaded: true, output: parsed.output })
  }
  fail(`Unknown files command '${sub}'.`)
}
