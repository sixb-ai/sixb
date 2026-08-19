import { humanize } from "../bash/interpret"

export interface ReadInput {
  readonly path: string
}

export interface ReadOutput {
  readonly path: string
  readonly content: string
  readonly startLine: number
  readonly endLine: number
  readonly truncated: boolean
  readonly nextOffset?: number
}

export interface ReadDescription {
  readonly path: string
  readonly target: string
  readonly detail?: string
  readonly skill: boolean
}

export function coerceReadInput(value: unknown): ReadInput | null {
  return isRecord(value) && typeof value.path === "string" ? { path: value.path } : null
}

export function coerceReadOutput(value: unknown): ReadOutput | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.content !== "string" ||
    typeof value.startLine !== "number" ||
    !Number.isInteger(value.startLine) ||
    typeof value.endLine !== "number" ||
    !Number.isInteger(value.endLine) ||
    typeof value.truncated !== "boolean" ||
    (value.nextOffset !== undefined &&
      (typeof value.nextOffset !== "number" || !Number.isInteger(value.nextOffset)))
  ) {
    return null
  }
  return {
    path: value.path,
    content: value.content,
    startLine: value.startLine,
    endLine: value.endLine,
    truncated: value.truncated,
    ...(typeof value.nextOffset === "number" ? { nextOffset: value.nextOffset } : {}),
  }
}

export function describeRead(input: ReadInput | null, output: ReadOutput | null): ReadDescription {
  const path = output?.path ?? input?.path ?? ""
  const skillTarget = describeSkillPath(path)
  return {
    path,
    target: skillTarget ?? fileName(path) ?? "a file",
    ...(output ? { detail: readDetail(output) } : {}),
    skill: skillTarget !== null,
  }
}

function describeSkillPath(path: string): string | null {
  const match = path.match(
    /(?:^|\/)\.sixb\/agent\/skills\/([^/]+)\/(?:references\/([^/]+)|SKILL\.md)$/
  )
  if (!match) return null
  if (match[2]) return `the ${humanize(match[2].replace(/\.[^.]+$/, ""))} reference`
  return `the ${humanize(match[1].replace(/^sixb-/, ""))} guide`
}

function readDetail(output: ReadOutput): string {
  if (!output.content) return "empty"
  const range =
    output.startLine === output.endLine
      ? `line ${output.startLine}`
      : `lines ${output.startLine}–${output.endLine}`
  return output.truncated ? `${range} · more available` : range
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
