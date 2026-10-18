import { artifactHref } from "../pages/routes"
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

/** The target's own page in the app, at its version and part. */
export function artifactTargetHref(target: ArtifactTarget): string {
  return artifactHref(target.artifactId, {
    ...(target.version === undefined ? {} : { version: target.version }),
    ...(target.part ? { part: target.part } : {}),
  })
}

/**
 * A link to the target's own page, for people to share: pinned to its version only when that is
 * not the latest, so a link to the current artifact keeps following its new versions.
 */
export function artifactLink(
  target: ArtifactTarget,
  latestVersion: number | undefined,
  origin: string
): string {
  const { version, ...unpinned } = target
  const pinned = version !== undefined && version !== latestVersion
  return new URL(artifactTargetHref(pinned ? target : unpinned), origin).toString()
}
