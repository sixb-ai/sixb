import type { FileSource } from "./file-source"

/** One artifact at a version and part, or a single file such as a message attachment. */
export type ViewerTarget = ArtifactTarget | FileTarget

export interface ArtifactTarget {
  readonly type: "artifact"
  readonly artifactId: string
  /** Omitted shows the latest version. */
  readonly version?: number
  /** A section, sheet, or slide to show first. */
  readonly part?: string
}

export interface FileTarget {
  readonly type: "file"
  readonly source: FileSource
}

/** Identity for "is this target the open one". */
export function viewerTargetKey(target: ViewerTarget): string {
  return target.type === "artifact" ? `artifact:${target.artifactId}` : `file:${target.source.id}`
}

/** Reads `?artifact=&v=&part=`; anything malformed reads as no target. */
export function artifactTargetFromSearch(params: URLSearchParams): ArtifactTarget | null {
  const artifactId = params.get("artifact")?.trim()
  if (!artifactId) return null
  const version = Number(params.get("v"))
  const part = params.get("part")?.trim()
  return {
    type: "artifact",
    artifactId,
    ...(Number.isSafeInteger(version) && version > 0 ? { version } : {}),
    ...(part ? { part } : {}),
  }
}

/** Writes a target into `params`, replacing any previous one; null removes it. */
export function withArtifactTarget(
  params: URLSearchParams,
  target: ArtifactTarget | null
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete("artifact")
  next.delete("v")
  next.delete("part")
  if (!target) return next
  next.set("artifact", target.artifactId)
  if (target.version !== undefined) next.set("v", String(target.version))
  if (target.part) next.set("part", target.part)
  return next
}

/** The address another artifact or a chat reply uses for this target. */
export function artifactAddress(target: ArtifactTarget, latestVersion?: number): string {
  const pinned =
    target.version !== undefined && target.version !== latestVersion ? `@${target.version}` : ""
  return `artifact:${target.artifactId}${pinned}${target.part ? `#${target.part}` : ""}`
}
