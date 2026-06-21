import type {
  GetAuthAccessManagementOptionsResponse,
  ListAuthAccessTokensResponse,
} from "@sixb/client"
import {
  Badge,
  Button,
  Calendar,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlertCircle,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock3,
  Copy,
  KeyRound,
  Loader2,
  Shield,
  XCircle,
} from "lucide-react"
import { useMemo, useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"

export type AuthGroupOption = GetAuthAccessManagementOptionsResponse["groups"][number]
export type AccessToken = ListAuthAccessTokensResponse["accessTokens"][number]

export function LoadingSpinner({
  className,
  size = "md",
  text,
}: {
  readonly className?: string
  readonly size?: "sm" | "md"
  readonly text?: string
}) {
  const spinner = (
    <Loader2 className={cn(size === "sm" ? "h-4 w-4" : "h-5 w-5", "animate-spin", className)} />
  )

  if (!text) {
    return spinner
  }

  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      {spinner}
      <span className="text-sm">{text}</span>
    </div>
  )
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    if ("error" in error && typeof error.error === "string") return error.error
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return fallback
}

export function groupLabel(group: AuthGroupOption): string {
  return group.label ?? humanizeIdentifier(group.id)
}

export function defaultExpiresOn(days = 90): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function dateInputToIso(value: string): string {
  return new Date(`${value}T23:59:59.999Z`).toISOString()
}

export function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const EXPIRATION_PRESETS = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
] as const

export function ExpirationPicker({
  disabled,
  value,
  onChange,
}: {
  readonly disabled?: boolean
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const [customMode, setCustomMode] = useState(false)
  const matchedPreset = EXPIRATION_PRESETS.find((preset) => defaultExpiresOn(preset.days) === value)
  const selectedPreset = customMode ? undefined : matchedPreset
  const selectedDate = dateInputValueToDate(value)
  const customSelected = !selectedPreset

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {EXPIRATION_PRESETS.map((preset) => {
          const selected = selectedPreset?.id === preset.id
          return (
            <Button
              key={preset.id}
              type="button"
              variant={selected ? "secondary" : "outline"}
              disabled={disabled}
              onClick={() => {
                setCustomMode(false)
                onChange(defaultExpiresOn(preset.days))
              }}
              className={cn(
                "h-9 rounded-lg border border-border/60 px-3",
                selected && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
              )}
            >
              {preset.label}
            </Button>
          )
        })}
        <Button
          type="button"
          variant={customSelected ? "secondary" : "outline"}
          disabled={disabled}
          onClick={() => setCustomMode(true)}
          className={cn(
            "h-9 rounded-lg border border-border/60 px-3",
            customSelected && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
          )}
        >
          Custom
        </Button>
      </div>

      {customSelected ? (
        <DatePicker
          value={value}
          onChange={(nextValue) => {
            setCustomMode(true)
            onChange(nextValue)
          }}
          disabled={disabled}
        />
      ) : (
        <p className="flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarIcon className="h-3.5 w-3.5" />
          Expires {selectedDate ? formatDateLabel(selectedDate) : "on selected date"}
        </p>
      )}
    </div>
  )
}

export function DatePicker({
  disabled,
  value,
  onChange,
}: {
  readonly disabled?: boolean
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = dateInputValueToDate(value)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-10 w-full justify-start rounded-lg border-border/60 bg-background px-3 text-left font-normal text-foreground"
        >
          <CalendarIcon className="h-4 w-4 text-muted-foreground" />
          <span>{selected ? formatDateLabel(selected) : "Select date"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          disabled={{ before: today }}
          onSelect={(date) => {
            if (!date) return
            onChange(dateToDateInputValue(date))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function dateInputValueToDate(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10))
  if (!year || !month || !day) {
    return undefined
  }

  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function dateToDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function GroupPicker({
  disabled,
  groups,
  selectedGroupIds,
  onChange,
}: {
  readonly disabled?: boolean
  readonly groups: readonly AuthGroupOption[]
  readonly selectedGroupIds: readonly string[]
  readonly onChange: (groupIds: string[]) => void
}) {
  const selected = useMemo(() => new Set(selectedGroupIds), [selectedGroupIds])

  const toggle = (groupId: string) => {
    if (selected.has(groupId)) {
      onChange(selectedGroupIds.filter((selectedGroupId) => selectedGroupId !== groupId))
      return
    }

    onChange([...selectedGroupIds, groupId])
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onChange([])}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          selectedGroupIds.length === 0
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border/60 bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        )}
      >
        <Shield className="h-4 w-4" />
        No groups
      </button>

      {groups.map((group) => {
        const active = selected.has(group.id)
        return (
          <button
            type="button"
            key={group.id}
            onClick={() => toggle(group.id)}
            disabled={disabled}
            className={cn(
              "inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/60 bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            )}
          >
            <Shield className="h-4 w-4 shrink-0" />
            <span className="truncate">{groupLabel(group)}</span>
          </button>
        )
      })}
    </div>
  )
}

export function GroupBadges({
  groupIds,
  groupOptionsById,
}: {
  readonly groupIds: readonly string[]
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
}) {
  if (groupIds.length === 0) {
    return (
      <Badge variant="secondary" className="rounded-md bg-muted text-xs">
        No groups
      </Badge>
    )
  }

  return (
    <div className="flex max-w-md flex-wrap gap-1.5">
      {groupIds.map((groupId) => (
        <Badge key={groupId} variant="secondary" className="rounded-md bg-accent/70 text-xs">
          {groupLabel(groupOptionsById.get(groupId) ?? { id: groupId })}
        </Badge>
      ))}
    </div>
  )
}

export function TokenStatusBadge({ status }: { readonly status: AccessToken["status"] }) {
  const Icon = status === "active" ? CheckCircle2 : status === "revoked" ? XCircle : Clock3
  const classes =
    status === "active"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "expired"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-muted-foreground/20 bg-muted text-muted-foreground"

  return (
    <Badge variant="outline" className={cn("rounded-md", classes)}>
      <Icon className="h-3 w-3" />
      {humanizeIdentifier(status)}
    </Badge>
  )
}

export function TokenReveal({
  label,
  tokenValue,
}: {
  readonly label: string
  readonly tokenValue: string
}) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tokenValue)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">{label}</h3>
          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
            Copy this token now. Atlas cannot show it again.
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-background px-3 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-500/10 dark:text-emerald-200"
        >
          <Copy className="h-4 w-4" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <input
        readOnly
        value={tokenValue}
        className="mt-3 h-10 w-full rounded-lg border border-emerald-500/30 bg-background px-3 font-mono text-xs text-foreground outline-none"
        onFocus={(event) => event.currentTarget.select()}
      />
      {copyFailed && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Clipboard access failed. Select the token field and copy it manually.
        </p>
      )}
    </div>
  )
}

export function AccessTokensTable({
  tokens,
  groupOptionsById,
  revokingTokenId,
  onRevoke,
}: {
  readonly tokens: readonly AccessToken[]
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
  readonly revokingTokenId: string | null
  readonly onRevoke: (tokenId: string) => void
}) {
  if (tokens.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound className="h-10 w-10" />}
        title="No tokens"
        description="Tokens created here will appear in this list."
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border/50 bg-muted text-xs text-muted-foreground">
            <th className="py-2 pl-4 pr-3 font-medium">Token</th>
            <th className="hidden px-3 py-2 font-medium md:table-cell">Groups</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="hidden px-3 py-2 font-medium lg:table-cell">Last used</th>
            <th className="hidden px-3 py-2 font-medium lg:table-cell">Expires</th>
            <th className="py-2 pl-3 pr-4 text-right font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token, index) => (
            <tr
              key={token.id}
              className={cn(
                "transition-colors hover:bg-muted/30",
                index !== tokens.length - 1 && "border-b border-border/40"
              )}
            >
              <td className="py-3 pl-4 pr-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{token.name}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {token.id}
                  </p>
                </div>
              </td>
              <td className="hidden px-3 py-3 md:table-cell">
                <GroupBadges groupIds={token.groupIds ?? []} groupOptionsById={groupOptionsById} />
              </td>
              <td className="px-3 py-3">
                <TokenStatusBadge status={token.status} />
              </td>
              <td className="hidden px-3 py-3 text-xs text-muted-foreground lg:table-cell">
                {token.lastUsedAt ? formatRelativeTime(token.lastUsedAt) : "Never"}
              </td>
              <td className="hidden px-3 py-3 text-xs text-muted-foreground lg:table-cell">
                {formatDateTime(token.expiresAt)}
              </td>
              <td className="py-3 pl-3 pr-4 text-right">
                {token.status === "revoked" ? (
                  <span className="text-xs text-muted-foreground">-</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRevoke(token.id)}
                    disabled={revokingTokenId === token.id}
                    className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {revokingTokenId === token.id ? "Revoking" : "Revoke"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AccessErrorState({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <EmptyState
      icon={<AlertCircle className="h-10 w-10" />}
      title={title}
      description={description}
    />
  )
}
