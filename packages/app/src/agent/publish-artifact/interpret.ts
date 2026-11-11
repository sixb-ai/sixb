import { ARTIFACT_KINDS } from "@sixb/core/artifacts"
import type { ArtifactKindName } from "../../artifacts/kind-icon"
import type { NormalizedPart, NormalizedTool } from "../parts"

/**
 * Creating an artifact, and changing one: `publish_artifact` with an id writes its current version.
 * Threads from before hold `update_artifact`, which did that, and `publish_artifact_version`,
 * which published the next version.
 */
const PUBLISH_TOOLS = new Set(["publish_artifact", "update_artifact", "publish_artifact_version"])

export function isPublishTool(toolName: string): boolean {
  return PUBLISH_TOOLS.has(toolName)
}

/** Whether a publish call changed an artifact that was there before, rather than created one. */
export function isUpdate(tool: Pick<NormalizedTool, "toolName" | "input">): boolean {
  if (tool.toolName !== "publish_artifact") return isPublishTool(tool.toolName)
  const input = tool.input
  return (
    typeof input === "object" &&
    input !== null &&
    "id" in input &&
    typeof input.id === "string" &&
    input.id.trim().startsWith("art_")
  )
}

/** What one publish call published, read from its result. */
export interface PublishedArtifact {
  readonly artifactId: string
  readonly version: number
  /** The artifact's revision once written: absent from calls made before revisions. */
  readonly revision?: number
  /** Whether the version written stays open; absent from calls made before open versions. */
  readonly open?: boolean
  readonly kind: ArtifactKindName
  readonly title: string
  readonly warnings: readonly { readonly message: string; readonly part?: string }[]
}

export function publishedArtifact(tool: NormalizedTool): PublishedArtifact | null {
  if (!isPublishTool(tool.toolName) || tool.state !== "output-available") return null
  const output = tool.output
  if (
    !isRecord(output) ||
    typeof output.artifactId !== "string" ||
    typeof output.version !== "number" ||
    typeof output.title !== "string" ||
    !(ARTIFACT_KINDS as readonly string[]).includes(String(output.kind))
  ) {
    return null
  }
  const warnings = Array.isArray(output.warnings) ? output.warnings : []
  return {
    artifactId: output.artifactId,
    version: output.version,
    ...(typeof output.revision === "number" ? { revision: output.revision } : {}),
    ...(typeof output.open === "boolean" ? { open: output.open } : {}),
    kind: output.kind as ArtifactKindName,
    title: output.title,
    warnings: warnings.flatMap((warning) =>
      isRecord(warning) && typeof warning.message === "string"
        ? [
            {
              message: warning.message,
              ...(typeof warning.part === "string" ? { part: warning.part } : {}),
            },
          ]
        : []
    ),
  }
}

/** The title a publish call names, from its result or, until then, its input. */
export function publishTitle(tool: NormalizedTool): string {
  const published = publishedArtifact(tool)
  if (published) return published.title
  return isRecord(tool.input) && typeof tool.input.title === "string" ? tool.input.title : ""
}

/** An artifact as a turn left it, and whether the turn created it or revised an earlier one. */
export interface TurnArtifact extends PublishedArtifact {
  readonly created: boolean
}

/**
 * Each artifact a turn published, once, as the turn last wrote it, in the order the turn first
 * published them.
 */
export function turnArtifacts(parts: readonly NormalizedPart[]): TurnArtifact[] {
  const byId = new Map<string, TurnArtifact>()
  for (const part of parts) {
    if (part.kind !== "tool") continue
    const published = publishedArtifact(part.tool)
    if (!published) continue
    const earlier = byId.get(published.artifactId)
    const created = earlier?.created === true || !isUpdate(part.tool)
    if (!earlier || writtenAfter(published, earlier)) {
      byId.set(published.artifactId, { ...published, created })
    } else if (created !== earlier.created) {
      byId.set(published.artifactId, { ...earlier, created })
    }
  }
  return [...byId.values()]
}

/** Whether one write came after another: by revision, else, before revisions, by version. */
function writtenAfter(later: PublishedArtifact, earlier: PublishedArtifact): boolean {
  if (later.revision !== undefined && earlier.revision !== undefined) {
    return later.revision > earlier.revision
  }
  return later.version > earlier.version
}

/**
 * The titles of what a finished turn last tried to publish and could not: a refused attempt that no
 * later publish of the same artifact (a version, by its id) or the same title (a new one) replaced.
 */
export function unpublishedTitles(parts: readonly NormalizedPart[]): string[] {
  const refused = new Map<string, string>()
  for (const part of parts) {
    if (part.kind !== "tool" || !isPublishTool(part.tool.toolName)) continue
    const result = publishedArtifact(part.tool)
    if (result) {
      refused.delete(`id:${result.artifactId}`)
      refused.delete(`title:${result.title}`)
      continue
    }
    if (part.tool.state !== "output-error") continue
    const input = isRecord(part.tool.input) ? part.tool.input : {}
    const key =
      typeof input.id === "string" ? `id:${input.id.trim()}` : `title:${publishTitle(part.tool)}`
    refused.set(key, publishTitle(part.tool))
  }
  return [...new Set(refused.values())]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
