import type { UserRef } from "@sixb/core"
import { cn } from "@sixb/ui/lib/utils"
import { classifyFileValue, type FileValueContext } from "../../lib/files"
import { formatValue } from "../../lib/formatValue"
import {
  describeValueSchema,
  userRefAt,
  type ValueSchema,
  type ValueSchemaNode,
} from "../../lib/valueSchema"
import { UserRefChip } from "../UserRefChip"
import { FileRefAttachment } from "./FileRefAttachment"

/**
 * One property value, rendered from its declared schema. Only a `fileRef`
 * position becomes an attachment, only a `userRef` position becomes a user, and
 * only a `date`/`timestamp` position becomes a date; everything else, including
 * values whose schema Atlas cannot read, uses the generic formatter.
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

  const node = describeValueSchema(schema)
  const user = userRefAt(node, value)
  if (user) return <UserRefChip userRef={user} />
  const users = userRefsAt(node, value)
  if (users) {
    return (
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5">
        {users.map((user, index) => (
          <UserRefChip key={`${user.id}:${index}`} userRef={user} />
        ))}
      </div>
    )
  }

  const { kind } = node
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

/** The users of a non-empty `userRef` array, or null unless every item is one. */
function userRefsAt(node: ValueSchemaNode, value: unknown): UserRef[] | null {
  if (node.kind !== "array" || !Array.isArray(value) || value.length === 0) return null
  const items = describeValueSchema(node.items)
  const users = value.map((item) => userRefAt(items, item))
  return users.every((user): user is UserRef => user !== null) ? users : null
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
