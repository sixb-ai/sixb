import { stableJsonStringify } from "../json"
import type { AgentContextPart } from "./context"

/** Project persisted context into one deterministic, escaped data block for the model. */
export function serializeAgentContextForModel(
  parts: readonly AgentContextPart[]
): string | undefined {
  if (parts.length === 0) return undefined

  const lines = ["<sixb_user_context>"]
  for (const part of parts) {
    if (part.context.kind === "object") {
      lines.push(
        "  <object_context>",
        `    <object_type_id>${escapeXml(part.context.ref.objectTypeId)}</object_type_id>`,
        `    <primary_id>${escapeXml(part.context.ref.primaryId)}</primary_id>`,
        "  </object_context>"
      )
      continue
    }

    lines.push(
      "  <app_state_context>",
      `    <id>${escapeXml(part.context.id)}</id>`,
      `    <description>${escapeXml(part.context.description)}</description>`,
      `    <value format="json">${escapeXml(stableJsonStringify(part.context.value))}</value>`,
      "  </app_state_context>"
    )
  }
  lines.push("</sixb_user_context>")
  return lines.join("\n")
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
