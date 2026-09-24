import { cn } from "@sixb/ui/lib/utils"
import { classifyFileValue, type FileValueContext } from "../../lib/files"
import { formatValue } from "../../lib/formatValue"
import { describeValueSchema, type ValueSchema } from "../../lib/valueSchema"
import { FileRefAttachment } from "./FileRefAttachment"

/**
 * One property value, rendered from its declared schema. Only a `fileRef`
 * position becomes an attachment and only a `date`/`timestamp` position becomes
 * a date; everything else, including values whose schema Atlas cannot read,
 * uses the generic formatter.
 */
export function PropertyValue({
  value,
  schema,
  fileContext,
}: {
  value: unknown
  schema: ValueSchema
  fileContext: FileValueContext
}) {
  const file = classifyFileValue(value, schema)
  if (file.kind === "single") {
    return <FileRefAttachment fileRef={file.fileRef} {...fileContext} />
  }
  if (file.kind === "array") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {file.fileRefs.map((fileRef, index) => (
          <FileRefAttachment
            key={`${fileRef.blobId}:${index}`}
            fileRef={fileRef}
            objectTypeId={fileContext.objectTypeId}
            primaryId={fileContext.primaryId}
            pathSegments={[...fileContext.pathSegments, String(index)]}
          />
        ))}
      </div>
    )
  }

  const { kind } = describeValueSchema(schema)
  if ((kind === "date" || kind === "timestamp") && typeof value === "string") {
    return <span title={value}>{formatDateValue(value, kind)}</span>
  }
  const formatted = formatValue(value)
  const isComplex = value !== null && typeof value === "object"
  const isMonoFriendly =
    !isComplex && (/^[a-z][a-z0-9_-]*$/i.test(formatted) || /^\d+$/.test(formatted))
  return (
    <span
      className={cn(
        "break-words",
        isComplex && "font-mono text-xs leading-relaxed",
        isMonoFriendly && "font-mono"
      )}
    >
      {formatted}
    </span>
  )
}

function formatDateValue(value: string, kind: "date" | "timestamp"): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    // A `date` is a calendar day stored as UTC midnight; formatting it in the
    // viewer's zone would show the previous day west of Greenwich.
    timeZone: kind === "date" ? "UTC" : undefined,
  })
}
