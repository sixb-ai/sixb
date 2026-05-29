import { cn } from "@pario/ui/lib/utils"
import { Box, Braces, Brackets, Check, Copy, Hash, Minus, Type } from "lucide-react"
import { useEffect, useRef, useState } from "react"

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
          <div className="border-l border-border pl-3">
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
          <div className="border-l border-border pl-3">
            <RunIOShape value={value} />
          </div>
        ) : null}
      </div>
    )
  }

  if (isLongString(value)) {
    return (
      <div className="space-y-1.5">
        {label ? <FieldLabel>{label}</FieldLabel> : null}
        <ExpandableText text={value} />
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

const LONG_STRING_THRESHOLD = 80

function isLongString(value: unknown): value is string {
  return typeof value === "string" && (value.length > LONG_STRING_THRESHOLD || value.includes("\n"))
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  // Measure overflow only while clamped — once expanded the element grows to fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text content changes (e.g. live output)
  useEffect(() => {
    const element = textRef.current
    if (!element || expanded) return
    setOverflowing(element.scrollHeight > element.clientHeight + 1)
  }, [expanded, text])

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <p
          ref={textRef}
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground",
            expanded ? "max-h-80 overflow-y-auto" : "line-clamp-3"
          )}
        >
          {text}
        </p>
        <CopyButton text={text} />
      </div>
      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard access can be blocked; failing silently is acceptable here.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy value"
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
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
