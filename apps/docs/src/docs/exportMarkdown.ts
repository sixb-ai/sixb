import { projects } from "../generated/projectFiles"
import { connectorCatalog } from "./connectorCatalog"
import { providerCatalog } from "./providerCatalog"
import { starterPrompt } from "./starterPrompt"

/** Keep interactive examples available in copied Markdown and the AI documentation corpus. */
export function exportMarkdown(markdown: string): string {
  let result = markdown
  const marker = "<div data-project-explorer></div>"
  if (result.includes(marker)) {
    const files = projects.starter.files
      .map(
        (file) =>
          `File: \`${file.path}\`\n\n${file.description}\n\n\`\`\`${file.path.endsWith("tsx") ? "tsx" : "ts"}\n${file.code}\n\`\`\``
      )
      .join("\n\n")
    result = result.replace(marker, files)
  }
  result = result.replace(
    "<div data-connector-library></div>",
    connectorCatalog
      .map(
        (entry) =>
          `- [${entry.name}](https://github.com/sixb-ai/sixb/tree/main/connectors/${entry.package}#readme) — ${entry.description}. Package: \`@sixb/connector-${entry.package}\`.`
      )
      .join("\n")
  )
  result = result.replace(
    "<div data-build-with-ai></div>",
    `Paste this prompt into your coding agent:\n\n\`\`\`text\n${starterPrompt}\n\`\`\``
  )
  for (const [kind, entries] of Object.entries(providerCatalog)) {
    result = result.replace(
      `<div data-provider-library="${kind}"></div>`,
      entries
        .map(
          (entry) =>
            `- [${entry.name}](${entry.href}): ${entry.description} Package: \`${entry.package}\`.`
        )
        .join("\n")
    )
  }
  return result
}
