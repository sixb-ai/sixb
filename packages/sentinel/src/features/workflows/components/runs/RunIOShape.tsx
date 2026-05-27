import { cn } from "@pario/ui/lib/utils"
import { Box, Braces, Brackets, Check, Hash, Minus, Type } from "lucide-react"

export function RunIOShape({
  value,
  emptyLabel = "No data",
}: {
  value: unknown
  emptyLabel?: string
}) {
  if (value === null || value === undefined) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  if (isObjectRef(value)) {
    return <ObjectRefChip objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-muted-foreground">Empty array</p>
    return (
      <ul className="divide-y divide-border/60 text-sm">
        {value.map((item, index) => (
          <li key={index} className="py-2 first:pt-0 last:pb-0">
            <RunValue value={item} label={`${index + 1}`} />
          </li>
        ))}
      </ul>
    )
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
    return (
      <ul className="divide-y divide-border/60 text-sm">
        {entries.map(([name, item]) => (
          <li key={name} className="py-2 first:pt-0 last:pb-0">
            <RunValue value={item} label={name} />
          </li>
        ))}
      </ul>
    )
  }

  return <RunValue value={value} />
}

function RunValue({ label, value }: { label?: string; value: unknown }) {
  if (isObjectRef(value)) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {label ? <FieldLabel>{label}</FieldLabel> : null}
        <ObjectRefChip objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
      </div>
    )
  }

  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {label ? <FieldLabel>{label}</FieldLabel> : null}
          <TypeChip icon="array" label="array" detail={`${value.length} items`} />
        </div>
        {value.length > 0 ? (
          <div className="rounded-md border border-border bg-background/60 px-3">
            <RunIOShape value={value} />
          </div>
        ) : null}
      </div>
    )
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {label ? <FieldLabel>{label}</FieldLabel> : null}
          <TypeChip icon="object" label="object" detail={`${entries.length} fields`} />
        </div>
        {entries.length > 0 ? (
          <div className="rounded-md border border-border bg-background/60 px-3">
            <RunIOShape value={value} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <PrimitiveValue value={value} />
    </div>
  )
}

function FieldLabel({ children }: { children: string }) {
  return <span className="min-w-0 font-medium text-foreground">{children}</span>
}

function ObjectRefChip({ objectTypeId, primaryId }: { objectTypeId: string; primaryId: string }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
        <Box className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        {objectTypeId}
        <span className="text-muted-foreground">object</span>
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">{primaryId}</span>
    </span>
  )
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <TypeChip icon="string" label={value} />
  }
  if (typeof value === "number") {
    return <TypeChip icon="number" label={String(value)} />
  }
  if (typeof value === "boolean") {
    return <TypeChip icon="boolean" label={value ? "true" : "false"} />
  }
  if (value === null || value === undefined) {
    return <TypeChip icon="empty" label="null" />
  }
  return <TypeChip icon="object" label={String(value)} />
}

function TypeChip({
  icon,
  label,
  detail,
}: {
  icon: "array" | "boolean" | "empty" | "number" | "object" | "string"
  label: string
  detail?: string
}) {
  const Icon = {
    array: Brackets,
    boolean: Check,
    empty: Minus,
    number: Hash,
    object: Braces,
    string: Type,
  }[icon]
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon className={cn("h-3 w-3", icon === "empty" && "text-muted-foreground")} />
      <span className="truncate">{label}</span>
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </span>
  )
}

function isObjectRef(value: unknown): value is { objectTypeId: string; primaryId: string } {
  return (
    isRecord(value) &&
    typeof value.objectTypeId === "string" &&
    typeof value.primaryId === "string" &&
    Object.keys(value).every((key) => key === "objectTypeId" || key === "primaryId")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
