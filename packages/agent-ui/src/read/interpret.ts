import { humanize } from "../bash/interpret"
import { type AgentMessages, en } from "../i18n/en"

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
  readonly title: string
  readonly runningTitle: string
  readonly failedTitle: string
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

export function describeRead(
  input: ReadInput | null,
  output: ReadOutput | null,
  messages: AgentMessages = en
): ReadDescription {
  const m = messages.read
  const path = output?.path ?? input?.path ?? ""
  const skill = describeSkillPath(path)
  const target = skill ? m[skill.kind] : m.file
  const name = skill?.name ?? fileName(path)
  return {
    path,
    title: target.title(name),
    runningTitle: target.running(name),
    failedTitle: target.failed(name),
    ...(output ? { detail: readDetail(output, m) } : {}),
    skill: skill !== null,
  }
}

function describeSkillPath(
  path: string
): { readonly kind: "reference" | "guide"; readonly name: string } | null {
  const match = path.match(
    /(?:^|\/)\.sixb\/agent\/skills\/([^/]+)\/(?:references\/([^/]+)|SKILL\.md)$/
  )
  if (!match) return null
  if (match[2]) return { kind: "reference", name: humanize(match[2].replace(/\.[^.]+$/, "")) }
  return { kind: "guide", name: humanize(match[1].replace(/^sixb-/, "")) }
}

function readDetail(output: ReadOutput, m: AgentMessages["read"]): string {
  if (!output.content) return m.empty
  const range =
    output.startLine === output.endLine
      ? m.line(output.startLine)
      : m.lines(output.startLine, output.endLine)
  return output.truncated ? m.moreAvailable(range) : range
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
