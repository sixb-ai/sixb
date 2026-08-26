import type { ReactNode } from "react"
import { CopyButton } from "../../../../components/CopyButton"

export function RunDebugSection({
  label,
  copyValue,
  copyLabel = `Copy ${label.toLowerCase()}`,
  children,
}: {
  label: string
  copyValue?: string
  copyLabel?: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {copyValue ? <CopyButton value={copyValue} label={copyLabel} /> : null}
      </div>
      {children}
    </section>
  )
}

export function RunMetadataRows({
  rows,
}: {
  rows: readonly (readonly [label: string, value: string])[]
}) {
  return (
    <dl className="divide-y divide-border/60">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-right font-mono text-xs text-foreground">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function stringifyRunDebugValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
