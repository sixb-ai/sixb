import type {
  GetAuthAccessManagementOptionsResponse,
  ListAuthAccessTokensResponse,
} from "@sixb/client"
import {
  Badge,
  Button,
  Calendar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlertCircle,
  Calendar as CalendarIcon,
  Check,
  Copy,
  KeyRound,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { type SubmitEvent, useEffect, useMemo, useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"

export type AuthGroupOption = GetAuthAccessManagementOptionsResponse["groups"][number]
export type AccessToken = ListAuthAccessTokensResponse["accessTokens"][number]

export type AccessTokenKind = "personal" | "service"

export interface CreatedTokenState {
  readonly tokenValue: string
  readonly name: string
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

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

export function formatDate(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

// A token id is `tok_<uuid>`. Show the prefix and last segment so it stays
// identifiable in logs without dumping a full uuid into every row.
export function maskTokenId(id: string): string {
  const body = id.replace(/^tok_/, "")
  if (body.length <= 12) return id
  return `tok_${body.slice(0, 4)}…${body.slice(-4)}`
}

// Best-effort, human-readable client from an untrusted user-agent. Tokens are
// often used by CLIs and CI, so non-browser clients come first.
export function describeClient(userAgent?: string): string | undefined {
  if (!userAgent) return undefined
  const ua = userAgent.trim()
  if (!ua) return undefined
  if (/sixb/i.test(ua)) return "Sixb CLI"
  if (/curl/i.test(ua)) return "curl"
  if (/wget/i.test(ua)) return "wget"
  if (/GitHub-Hookshot|actions\//i.test(ua)) return "GitHub Actions"
  if (/node(?:\.js)?\/|undici|axios|got\//i.test(ua)) return "Node.js"
  if (/python|httpx|aiohttp/i.test(ua)) return "Python"
  if (/Go-http-client/i.test(ua)) return "Go"
  if (/PostmanRuntime/i.test(ua)) return "Postman"

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : undefined
  if (!browser) return undefined
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Macintosh|Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : undefined
  return os ? `${browser} on ${os}` : browser
}

interface ExpiryInfo {
  readonly label: string
  readonly soon: boolean
}

// Expiry copy that adapts to how close the token is. "Soon" drives the amber
// treatment so an about-to-lapse credential reads as a warning, not a fact.
export function expiryInfo(token: AccessToken): ExpiryInfo {
  if (token.status === "revoked") {
    return {
      label: token.revokedAt ? `Revoked ${formatDate(token.revokedAt)}` : "Revoked",
      soon: false,
    }
  }
  if (token.status === "expired") {
    return { label: `Expired ${formatDate(token.expiresAt)}`, soon: false }
  }

  const days = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000)
  if (days <= 0) return { label: "Expires today", soon: true }
  if (days === 1) return { label: "Expires tomorrow", soon: true }
  if (days <= 45) return { label: `Expires in ${days} days`, soon: days <= 14 }
  return { label: `Expires ${formatDate(token.expiresAt)}`, soon: false }
}

function usageLabel(token: AccessToken): string {
  if (!token.lastUsedAt) return "Never used"
  const client = describeClient(token.lastUsedUserAgent)
  const relative = formatRelativeTime(token.lastUsedAt)
  return client ? `Used ${relative} · ${client}` : `Used ${relative}`
}

// ---------------------------------------------------------------------------
// Expiration + group pickers (used inside the create dialogs)
// ---------------------------------------------------------------------------

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
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-2">
        {EXPIRATION_PRESETS.map((preset) => {
          const selected = selectedPreset?.id === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                setCustomMode(false)
                onChange(defaultExpiresOn(preset.days))
              }}
              className={cn(
                "inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-ring/40 bg-primary/6 text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              {preset.label}
            </button>
          )
        })}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCustomMode(true)}
          className={cn(
            "inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            customSelected
              ? "border-ring/40 bg-primary/6 text-foreground"
              : "border-border/60 bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          Custom
        </button>
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
          Expires {selectedDate ? formatDateLabel(selectedDate) : "on the selected date"}
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
  if (!year || !month || !day) return undefined
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
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
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

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Your account has no assignable groups, so this credential carries no extra scopes.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((group) => {
        const active = selected.has(group.id)
        return (
          <button
            type="button"
            key={group.id}
            onClick={() => toggle(group.id)}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
              "inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "border-ring/40 bg-primary/6 text-foreground"
                : "border-border/60 bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                active ? "border-foreground bg-foreground text-background" : "border-border"
              )}
            >
              {active ? <Check className="h-3 w-3" /> : null}
            </span>
            <span className="truncate">{groupLabel(group)}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ScopeChips({
  groupIds,
  groupOptionsById,
  emptyLabel = "No scopes",
}: {
  readonly groupIds: readonly string[]
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
  readonly emptyLabel?: string
}) {
  if (groupIds.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {groupIds.map((groupId) => (
        <span
          key={groupId}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground/80"
        >
          <ShieldCheck className="h-3 w-3 text-muted-foreground" />
          {groupLabel(groupOptionsById.get(groupId) ?? { id: groupId })}
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function StatusDot({
  status,
  soon,
}: {
  readonly status: AccessToken["status"]
  readonly soon: boolean
}) {
  const tone =
    status === "active" && soon
      ? "bg-amber-500 ring-amber-500/20"
      : status === "active"
        ? "bg-emerald-500 ring-emerald-500/20"
        : "bg-muted-foreground/40 ring-transparent"
  return <span className={cn("mt-1.75 h-2 w-2 shrink-0 rounded-full ring-4", tone)} />
}

export function TokenStatusPill({
  status,
  soon = false,
}: {
  readonly status: AccessToken["status"]
  readonly soon?: boolean
}) {
  if (status === "active" && soon) {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        Expiring soon
      </Badge>
    )
  }
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        Active
      </Badge>
    )
  }
  if (status === "expired") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        Expired
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="rounded-full border-border/60 bg-muted text-muted-foreground"
    >
      Revoked
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Token list (rich rows)
// ---------------------------------------------------------------------------

export function TokenList({
  tokens,
  groupOptionsById,
  revokingTokenId,
  onRevoke,
  emptyTitle = "No tokens yet",
  emptyDescription = "Tokens you create will appear here.",
}: {
  readonly tokens: readonly AccessToken[]
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
  readonly revokingTokenId: string | null
  readonly onRevoke: (tokenId: string) => void
  readonly emptyTitle?: string
  readonly emptyDescription?: string
}) {
  if (tokens.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound className="h-9 w-9" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    )
  }

  return (
    <ul className="divide-y divide-border/60">
      {tokens.map((token) => (
        <TokenRow
          key={token.id}
          token={token}
          groupOptionsById={groupOptionsById}
          revoking={revokingTokenId === token.id}
          onRevoke={onRevoke}
        />
      ))}
    </ul>
  )
}

function TokenRow({
  token,
  groupOptionsById,
  revoking,
  onRevoke,
}: {
  readonly token: AccessToken
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
  readonly revoking: boolean
  readonly onRevoke: (tokenId: string) => void
}) {
  const exp = expiryInfo(token)
  const active = token.status === "active"
  const groupIds = token.groupIds ?? []

  return (
    <li className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30">
      <StatusDot status={token.status} soon={exp.soon} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold text-foreground">{token.name}</span>
          <TokenStatusPill status={token.status} soon={exp.soon} />
          <span className="font-mono text-xs text-muted-foreground">{maskTokenId(token.id)}</span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {groupIds.length > 0 ? (
            <>
              <ScopeChips groupIds={groupIds} groupOptionsById={groupOptionsById} />
              <span className="text-muted-foreground/50">·</span>
            </>
          ) : null}
          <span>{usageLabel(token)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className={cn(exp.soon && "font-medium text-amber-600 dark:text-amber-400")}>
            {exp.label}
          </span>
        </div>
      </div>

      <div className="shrink-0">
        {active ? (
          <button
            type="button"
            onClick={() => onRevoke(token.id)}
            disabled={revoking}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            {revoking ? "Revoking…" : "Revoke"}
          </button>
        ) : (
          <span className="pr-1 text-xs text-muted-foreground/60">—</span>
        )}
      </div>
    </li>
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
      icon={<AlertCircle className="h-9 w-9" />}
      title={title}
      description={description}
    />
  )
}

// ---------------------------------------------------------------------------
// Create-token dialog (configure → one-time reveal)
// ---------------------------------------------------------------------------

export function TokenFormDialog({
  open,
  onOpenChange,
  kind,
  groups,
  defaultGroupIds,
  onSubmit,
  isSubmitting,
  errorMessage,
  created,
  disabled,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly kind: AccessTokenKind
  readonly groups: readonly AuthGroupOption[]
  readonly defaultGroupIds: readonly string[]
  readonly onSubmit: (body: { name: string; expiresAt: string; groupIds: string[] }) => void
  readonly isSubmitting: boolean
  readonly errorMessage: string | null
  readonly created: CreatedTokenState | null
  readonly disabled?: boolean
}) {
  const [name, setName] = useState("")
  const [expiresOn, setExpiresOn] = useState(defaultExpiresOn())
  const [selectedGroupIds, setSelectedGroupIds] = useState<readonly string[]>(defaultGroupIds)
  const [localError, setLocalError] = useState<string | null>(null)

  // Reset the form each time the dialog opens so it never reopens half-filled.
  useEffect(() => {
    if (!open) return
    setName("")
    setExpiresOn(defaultExpiresOn())
    setSelectedGroupIds(defaultGroupIds)
    setLocalError(null)
  }, [open, defaultGroupIds])

  const titleNoun = kind === "service" ? "service-account token" : "personal access token"
  const canSubmit = name.trim().length > 0 && expiresOn.length > 0 && !isSubmitting && !disabled

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    try {
      onSubmit({
        name: name.trim(),
        expiresAt: dateInputToIso(expiresOn),
        groupIds: [...selectedGroupIds],
      })
      setLocalError(null)
    } catch {
      setLocalError("Choose a valid expiration date.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={!created}>
        {created ? (
          <TokenReveal kind={kind} created={created} onDone={() => onOpenChange(false)} />
        ) : (
          <form onSubmit={submit}>
            <DialogHeader className="space-y-1.5 p-5 pb-0 text-left">
              <DialogTitle className="text-base">
                New {kind === "service" ? "service-account token" : "personal access token"}
              </DialogTitle>
              <DialogDescription>
                {kind === "service"
                  ? "Authenticates as this service account, with at most its scopes."
                  : "Authenticates the CLI and API as you, with at most your own access."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 p-5">
              <div className="space-y-2">
                <label htmlFor="token-name" className="block text-xs font-medium text-foreground">
                  Name
                </label>
                <input
                  id="token-name"
                  type="text"
                  value={name}
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                  placeholder={kind === "service" ? "Sandbox agent" : "Local CLI"}
                  className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
                />
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-foreground">Expiration</span>
                <ExpirationPicker
                  value={expiresOn}
                  onChange={setExpiresOn}
                  disabled={isSubmitting}
                />
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-foreground">Scopes</span>
                <p className="-mt-0.5 text-xs text-muted-foreground">
                  A token can never exceed {kind === "service" ? "the account's" : "your own"}{" "}
                  access. Choose which groups it inherits.
                </p>
                <GroupPicker
                  groups={groups}
                  selectedGroupIds={selectedGroupIds}
                  onChange={setSelectedGroupIds}
                  disabled={isSubmitting}
                />
              </div>

              {(localError || errorMessage) && (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  {localError ?? errorMessage}
                </p>
              )}
            </div>

            <DialogFooter className="border-t border-border/60 bg-muted/30 p-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                Create {titleNoun.split(" ").pop()}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TokenReveal({
  kind,
  created,
  onDone,
}: {
  readonly kind: AccessTokenKind
  readonly created: CreatedTokenState
  readonly onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.tokenValue)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }

  return (
    <div>
      <DialogHeader className="space-y-1.5 p-5 pb-0 text-left">
        <DialogTitle className="text-base">Copy your token</DialogTitle>
        <DialogDescription>Store it somewhere safe — you can revoke it any time.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 p-5">
        <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm font-medium text-emerald-800 dark:text-emerald-200">
          <Check className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            {kind === "service" ? "Service-account token" : "Token"} “{created.name}” is ready
          </span>
        </div>

        <div className="flex items-stretch overflow-hidden rounded-lg border border-border/60 bg-background">
          <code className="min-w-0 flex-1 break-all px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
            {created.tokenValue}
          </code>
          <button
            type="button"
            onClick={copy}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-l border-border/60 bg-card px-3.5 text-xs font-medium transition-colors hover:bg-accent",
              copied ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            This is the only time the full token is shown. If you lose it, create a new one and
            revoke this.
          </p>
        </div>

        {copyFailed && (
          <p className="text-xs text-muted-foreground">
            Clipboard access failed. Select the token above and copy it manually.
          </p>
        )}
      </div>

      <DialogFooter className="border-t border-border/60 bg-muted/30 p-4">
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}
