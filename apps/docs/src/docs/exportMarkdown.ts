import { projects } from "../generated/projectFiles"
import { connectorCatalog } from "./connectorCatalog"

/** Keep interactive examples available in copied Markdown and the AI documentation corpus. */
export function exportMarkdown(markdown: string): string {
  let result = markdown
  for (const [name, project] of Object.entries(projects)) {
    const marker =
      name === "starter"
        ? "<div data-project-explorer></div>"
        : `<div data-code-explorer="${name}"></div>`
    if (!result.includes(marker)) continue
    const files = project.files
      .map(
        (file) =>
          `File: \`${file.path}\`\n\n${file.description}\n\n\`\`\`${file.path.endsWith("tsx") ? "tsx" : "ts"}\n${file.code}\n\`\`\``
      )
      .join("\n\n")
    result = result.replace(marker, files)
  }
  result = result.replace(
    "<div data-data-flow></div>",
    "Connector → Sync → Raw dataset → Pipeline (optional) → Clean dataset → Projection → Objects → App"
  )
  result = result.replace(
    "<div data-connector-library></div>",
    connectorCatalog
      .map(
        (entry) =>
          `- [${entry.name}](https://github.com/sixb-ai/sixb/tree/main/connectors/${entry.package}#readme) — ${entry.description}. Package: \`@sixb/connector-${entry.package}\`.`
      )
      .join("\n")
  )
  return result
}
