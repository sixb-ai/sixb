/**
 * Formatting for object query explanations.
 *
 * Lives apart from `explain.ts` so the fluent builder (and browser bundles
 * built on it) can import the formatter without pulling in the explanation
 * builder and its validation machinery.
 */
import type { ObjectQueryExplainNode, ObjectQueryExplanation } from "./explain"

export function formatObjectQueryExplanation(explanation: ObjectQueryExplanation): string {
  const lines: string[] = []
  const status =
    explanation.valid === undefined ? "not validated" : explanation.valid ? "valid" : "invalid"
  const result = explanation.result ? ` result=${explanation.result.objectTypeIds.join(" | ")}` : ""

  lines.push(`ObjectQuery ${status}${result}`)
  appendNodeLines(explanation.tree, lines, 0)

  if (explanation.issues.length > 0) {
    lines.push("Issues:")
    for (const issue of explanation.issues) {
      lines.push(`- ${issue.path} [${issue.code}] ${issue.message}`)
    }
  }

  return lines.join("\n")
}

function appendNodeLines(node: ObjectQueryExplainNode, lines: string[], depth: number): void {
  lines.push(`${"  ".repeat(depth)}- ${node.path} ${node.summary}`)
  for (const child of node.children) {
    appendNodeLines(child, lines, depth + 1)
  }
}
