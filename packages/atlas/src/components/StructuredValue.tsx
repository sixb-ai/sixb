import { type FileRef, fileNameFor, isFileRef } from "@sixb/core/blob-storage"
import { cn } from "@sixb/ui/lib/utils"
import {
  Box,
  Braces,
  Brackets,
  Check,
  Copy,
  Download,
  Eye,
  FileIcon,
  Hash,
  Minus,
  Type,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { fileMediaLabel, formatFileSize } from "../lib/files"

export interface FileContentLinks {
  readonly inlineUrl: string
  readonly downloadUrl: string
}

export type FileLinkForPath = (path: readonly string[]) => FileContentLinks | null

export type StructuredValueVariant = "default" | "debug"

export function StructuredValue({
  value,
  emptyLabel = "No data",
  fileLinkForPath,
  path = [],
  variant = "default",
}: {
  value: unknown
  emptyLabel?: string
  fileLinkForPath?: FileLinkForPath
  path?: readonly string[]
  variant?: StructuredValueVariant
}) {
  if (value === null || value === undefined) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  if (isObjectRef(value)) {
    return variant === "debug" ? (
      <DebugObjectRef objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
    ) : (
      <ObjectRefChip objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
    )
  }

  if (isFileRef(value)) {
    return (
      <FileRefValue fileRef={value} links={fileLinkForPath?.(path) ?? null} variant={variant} />
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-muted-foreground">Empty array</p>
    return (
      <ul className="divide-y divide-border/60 text-sm">
        {value.map((item, index) => (
          <li key={index} className="py-2 first:pt-0 last:pb-0">
            <RunValue
              value={item}
              label={`${index + 1}`}
              path={[...path, String(index)]}
              fileLinkForPath={fileLinkForPath}
              variant={variant}
            />
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
            <RunValue
              value={item}
              label={name}
              path={[...path, name]}
              fileLinkForPath={fileLinkForPath}
              variant={variant}
            />
          </li>
        ))}
      </ul>
    )
  }

  return <RunValue value={value} path={path} fileLinkForPath={fileLinkForPath} variant={variant} />
}

function RunValue({
  label,
  value,
  path,
  fileLinkForPath,
  variant,
}: {
  label?: string
  value: unknown
  path: readonly string[]
  fileLinkForPath?: FileLinkForPath
  variant: StructuredValueVariant
}) {
  if (isObjectRef(value)) {
    if (variant === "debug") {
      return (
        <DebugField label={label}>
          <DebugObjectRef objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
        </DebugField>
      )
    }
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {label ? <FieldLabel>{label}</FieldLabel> : null}
        <ObjectRefChip objectTypeId={value.objectTypeId} primaryId={value.primaryId} />
      </div>
    )
  }

  if (isFileRef(value)) {
    return (
      <DebugField label={label} stacked={variant === "default"}>
        <FileRefValue fileRef={value} links={fileLinkForPath?.(path) ?? null} variant={variant} />
      </DebugField>
    )
  }

  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {variant === "debug" ? (
          <DebugField label={label}>
            <CollectionSummary type="array" count={value.length} />
          </DebugField>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {label ? <FieldLabel>{label}</FieldLabel> : null}
            <TypeChip icon="array" label="array" detail={`${value.length} items`} />
          </div>
        )}
        {value.length > 0 ? (
          <div className="border-l border-border pl-3">
            <StructuredValue
              value={value}
              path={path}
              fileLinkForPath={fileLinkForPath}
              variant={variant}
            />
          </div>
        ) : null}
      </div>
    )
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    return (
      <div className="space-y-2">
        {variant === "debug" ? (
          <DebugField label={label}>
            <CollectionSummary type="object" count={entries.length} />
          </DebugField>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {label ? <FieldLabel>{label}</FieldLabel> : null}
            <TypeChip icon="object" label="object" detail={`${entries.length} fields`} />
          </div>
        )}
        {entries.length > 0 ? (
          <div className="border-l border-border pl-3">
            <StructuredValue
              value={value}
              path={path}
              fileLinkForPath={fileLinkForPath}
              variant={variant}
            />
          </div>
        ) : null}
      </div>
    )
  }

  if (typeof value === "string" && (variant === "debug" || isLongString(value))) {
    return (
      <DebugField label={label} stacked={variant === "default"}>
        <ExpandableText text={value} />
      </DebugField>
    )
  }

  if (variant === "debug") {
    return (
      <DebugField label={label}>
        <DebugPrimitiveValue value={value} />
      </DebugField>
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
  return <span className="min-w-0 break-words font-medium text-foreground">{children}</span>
}

function DebugField({
  label,
  children,
  stacked = false,
}: {
  label?: string
  children: ReactNode
  stacked?: boolean
}) {
  if (!label) return <>{children}</>
  return stacked ? (
    <div className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  ) : (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)] gap-3">
      <FieldLabel>{label}</FieldLabel>
      <div className="min-w-0">{children}</div>
    </div>
  )
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

function DebugObjectRef({ objectTypeId, primaryId }: { objectTypeId: string; primaryId: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Box className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="font-medium text-foreground">{objectTypeId}</span>
      <span className="text-muted-foreground">object</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span className="min-w-[8rem] flex-1 break-all font-mono text-muted-foreground">
        {primaryId}
      </span>
    </span>
  )
}

function CollectionSummary({ type, count }: { type: "array" | "object"; count: number }) {
  const Icon = type === "array" ? Brackets : Braces
  const unit =
    type === "array" ? (count === 1 ? "item" : "items") : count === 1 ? "field" : "fields"
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      {type} · {count} {unit}
    </span>
  )
}

function FileRefValue({
  fileRef,
  links,
  variant,
}: {
  fileRef: FileRef
  links: FileContentLinks | null
  variant: StructuredValueVariant
}) {
  const fileName = fileNameFor(fileRef)
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md text-xs",
        variant === "debug"
          ? "bg-muted/20 px-2.5 py-2"
          : "border border-border bg-background px-3 py-2.5"
      )}
    >
      <span className="inline-flex min-w-0 flex-1 items-center gap-2.5">
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 font-medium text-foreground",
            variant === "debug" ? "break-all" : "truncate"
          )}
          title={fileName}
        >
          {fileName}
        </span>
        <span
          className={cn("text-muted-foreground", variant === "debug" ? "break-words" : "shrink-0")}
        >
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes)}
        </span>
      </span>
      {links ? (
        <span className="inline-flex shrink-0 items-center gap-2">
          <a
            href={links.inlineUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Eye className="h-3.5 w-3.5" />
            View
          </a>
          <a
            href={links.downloadUrl}
            download={fileName}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        </span>
      ) : null}
    </div>
  )
}

function DebugPrimitiveValue({ value }: { value: unknown }) {
  const { Icon, text } =
    typeof value === "number"
      ? { Icon: Hash, text: String(value) }
      : typeof value === "boolean"
        ? { Icon: Check, text: value ? "true" : "false" }
        : value === null || value === undefined
          ? { Icon: Minus, text: "null" }
          : { Icon: Braces, text: String(value) }

  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs text-foreground">
      <Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-all font-mono">{text}</span>
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
