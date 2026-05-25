import { Button, Card, CardContent, EmptyState } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { AlertCircle, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

export function PageFrame({
  eyebrow,
  title,
  description,
  backTo,
  backLabel,
  contentClassName,
  children,
}: {
  eyebrow?: string
  title: string
  description?: ReactNode
  backTo?: string
  backLabel?: string
  contentClassName?: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-3 sm:p-4 lg:p-6">
      <div className={cn("flex w-full flex-col gap-4", contentClassName)}>
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
        <header className="space-y-1">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <div className="max-w-3xl text-sm text-muted-foreground">{description}</div>
          ) : null}
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

export function JsonPreview({ label, value }: { label?: string; value: unknown }) {
  const rendered = JSON.stringify(value ?? null, null, 2)
  return (
    <div className="min-w-0 space-y-2">
      {label ? (
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      ) : null}
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground scrollbar-auto-hide">
        {rendered}
      </pre>
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
