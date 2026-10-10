import { type NormalizedFile, type NormalizedTool, toolResultFiles } from "../parts"

export interface ViewFileDescription {
  /** The file name, or a generic stand-in until the call names one. */
  readonly target: string
  /** The file the call prepared for the model, once it has a result. */
  readonly file?: NormalizedFile
}

export function describeViewFile(tool: NormalizedTool): ViewFileDescription {
  // A saved message resolves each file's source; a live result only carries its reference.
  const file =
    tool.files?.[0] ??
    toolResultFiles(tool.output).map(({ fileRef }): NormalizedFile => ({ fileRef }))[0]
  const path = isRecord(tool.input) && typeof tool.input.path === "string" ? tool.input.path : ""
  const target =
    file?.fileRef.fileName?.trim() || path.split("/").filter(Boolean).at(-1) || "a file"
  return file ? { target, file } : { target }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
