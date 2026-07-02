import { Button, Card, CardContent, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AlertCircle, ChevronLeft, Loader2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type FileLinkForPath, StructuredValue } from "./StructuredValue"

type AvatarSize = "xs" | "sm" | "md" | "lg"

const avatarSizeClasses: Record<AvatarSize, string> = {
  xs: "size-5 rounded-md text-[10px]",
  sm: "size-7 rounded-md text-xs",
  md: "size-10 rounded-lg text-base",
  lg: "size-12 rounded-lg text-lg",
}

export function LetterAvatar({ label, size = "xs" }: { label: string; size?: AvatarSize }) {
  const letter = label.trim()[0]?.toUpperCase() ?? "?"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-muted font-mono font-medium text-muted-foreground",
        avatarSizeClasses[size]
      )}
    >
      {letter}
    </span>
  )
}

export function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children?: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {count != null ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">· {count}</span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

export function BackNav({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate(to)}
      className="-ml-2 self-start text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft />
      {label}
    </Button>
  )
}

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function PageFrame({
  eyebrow,
  title,
  description,
  backTo,
  backLabel,
  actions,
  contentClassName,
  children,
}: {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  backTo?: string
  backLabel?: string
  actions?: ReactNode
  contentClassName?: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col p-3 sm:p-4 lg:p-6">
      <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-4", contentClassName)}>
        {backTo && backLabel ? (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="-ml-2 self-start text-muted-foreground hover:text-foreground"
          >
            <Link to={backTo}>{backLabel}</Link>
          </Button>
        ) : null}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            {eyebrow ? (
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {title}
            </h1>
            {description ? (
              <div className="max-w-3xl text-sm text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {actions ? <div className="shrink-0 sm:pt-1">{actions}</div> : null}
        </header>
        {children}
      </div>
    </div>
  )
}

export function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      </CardContent>
    </Card>
  )
}

export function KeyValue({ label, value, to }: { label: string; value: string; to?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="break-words text-foreground">
        {to ? (
          <Link to={to} className="underline-offset-4 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </p>
    </div>
  )
}

type DataPanelMode = "structured" | "raw"

export function DataPanel({
  label,
  value,
  emptyLabel = "Not recorded",
  fileLinkForPath,
}: {
  label?: string
  value: unknown
  emptyLabel?: string
  fileLinkForPath?: FileLinkForPath
}) {
  const [mode, setMode] = useState<DataPanelMode>("structured")
  const isEmpty = value === null || value === undefined

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        {label ? (
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
        ) : (
          <span />
        )}
        {isEmpty ? null : (
          <div className="inline-flex rounded-md bg-muted p-0.5">
            {(["structured", "raw"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={cn(
                  "rounded-[5px] px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                  mode === option
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
      {isEmpty ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : mode === "structured" ? (
        <StructuredValue value={value} emptyLabel={emptyLabel} fileLinkForPath={fileLinkForPath} />
      ) : (
        <pre className="max-h-72 overflow-auto text-xs leading-relaxed text-muted-foreground scrollbar-auto-hide">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function LoadingPage({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <LoadingInline label={label} />
    </div>
  )
}

export function LoadingInline({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function ErrorPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 sm:p-8">
      <Card className="mx-auto max-w-md p-6 text-center">
        <EmptyState
          icon={<AlertCircle className="size-12 stroke-1" />}
          title={title}
          description={description}
        />
        <Button
          variant="outline"
          size="sm"
          className="mx-auto mt-2"
          onClick={() => window.location.reload()}
        >
          Retry
        </Button>
      </Card>
    </div>
  )
}
