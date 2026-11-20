import type { DeployCommand, DeployRecord, DeployRelease } from "@sixb/core/deploy"

/** What the laptop sends the server's runner: the release, and how it was asked for. */
export interface ReleasePlan {
  readonly version: 1
  readonly release: DeployRelease
  readonly record: DeployRecord
  readonly releaseId: string
  readonly projectPath: string
  /** A migration that breaks the live release may stop the services while it runs. */
  readonly acceptDowntime: boolean
}

/** Starts every progress line, so the laptop tells events from a command's output (RFC 7464). */
export const EVENT_PREFIX = "\u001e"

export type ReleaseEvent =
  | { readonly step: string; readonly status: "running" | "done" }
  | { readonly exit: number }

export function event(value: ReleaseEvent): string {
  return `${EVENT_PREFIX}${JSON.stringify(value)}`
}

export function parseEvent(line: string): ReleaseEvent | null {
  if (!line.startsWith(EVENT_PREFIX)) return null
  try {
    return JSON.parse(line.slice(EVENT_PREFIX.length)) as ReleaseEvent
  } catch {
    return null
  }
}

/** The steps a deploy runs, in order: the upload, then what the server does. */
export function releaseStepLabels(release: DeployRelease): string[] {
  return [
    "Upload source",
    "Prepare release",
    `Install Bun ${release.bunVersion}`,
    "Install dependencies",
    ...(release.steps.env ? [commandLabel(release.steps.env)] : []),
    ...release.steps.build.map(commandLabel),
    ...release.steps.beforeStart.map(commandLabel),
    "Start new release",
    "Check services",
    "Update routes",
    "Move singletons",
    "Retire previous release",
  ]
}

export function commandLabel(command: DeployCommand): string {
  return [command.program, ...command.args].join(" ")
}

/** A release folder's name: when, then which commit. */
export function deriveReleaseId(record: DeployRecord): string {
  const stamp = record.deployedAt.replace(/[-:.]/g, "").slice(0, 15)
  const sha = record.commit.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "")
  return `${stamp}Z-${sha || "release"}`
}
