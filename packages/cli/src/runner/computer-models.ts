import { type ClaudeCodeProvider, createClaudeCode } from "@sixb/claude-code"
import type { DescribedLanguageModel } from "@sixb/core/internal/agents"
import type { LanguageModel } from "@sixb/core/models"

let claudeCode: ClaudeCodeProvider | undefined

/**
 * This computer's own copy of a project model that runs on computers: Claude through the Claude
 * Code signed in here, so a turn that runs here is billed to its person's own Claude plan.
 */
export function computerModel(described: DescribedLanguageModel): LanguageModel | undefined {
  if (described.providerId !== "claude-code") return undefined

  claudeCode ??= createClaudeCode(compiled() ? { executable: Bun.which("claude") ?? "claude" } : {})
  return claudeCode(described.modelId)
}

/**
 * A program compiled with Bun, as the desktop app's runner is, cannot start the Claude Code the SDK
 * ships: it runs the `claude` the person installed instead.
 */
function compiled(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\")
}
