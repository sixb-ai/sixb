import type {
  GetAuthAccessManagementOptionsResponse,
  ListAuthAccessTokensResponse,
} from "@sixb/client"
import {
  Button,
  Calendar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import {
  Calendar as CalendarIcon,
  Check,
  CircleAlert,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  TriangleAlert,
} from "lucide-react"
import {
  type ComponentType,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useSettingsMessages } from "./messages"

export type AuthGroupOption = GetAuthAccessManagementOptionsResponse["groups"][number]
export type AccessToken = ListAuthAccessTokensResponse["accessTokens"][number]
export type AccessTokenKind = "personal" | "service"
type Icon = ComponentType<{ readonly className?: string }>

export interface CreatedTokenState {
  readonly tokenValue: string
  readonly name: string
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    if ("error" in error && typeof error.error === "string") return error.error
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return fallback
}

export function groupLabel(group: { readonly id: string; readonly label?: string }): string {
  if (group.label) return group.label
  const words = group.id.replace(/[._-]+/g, " ").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : group.id
}

/** Dates and times in the reader's locale. */
export function useFormat() {
  const locale = useLocale()
  const unknown = useSettingsMessages().common.unknown
  return useMemo(() => {
    const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    const parse = (timestamp: string) => {
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? null : date
    }
    return {
      date(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
      },
      dateTime(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
      },
      /** "now", "5 minutes ago", "yesterday", in the reader's language. */
      relative(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        const seconds = Math.round((date.getTime() - Date.now()) / 1000)
        const minutes = Math.round(seconds / 60)
        const hours = Math.round(minutes / 60)
        const days = Math.round(hours / 24)
        if (Math.abs(seconds) < 60) return relativeFormat.format(0, "second")
        if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute")
        if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour")
        return relativeFormat.format(days, "day")
      },
    }
  }, [locale, unknown])
}

// A token id is `tok_<uuid>`: keep the prefix and both ends so it stays recognizable in logs.
export function maskId(id: string, prefix: string): string {
  const body = id.startsWith(prefix) ? id.slice(prefix.length) : id
  if (body.length <= 12) return id
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`
}

function browserOf(userAgent: string): string | undefined {
  if (/Edg\//.test(userAgent)) return "Edge"
  if (/OPR\/|Opera/.test(userAgent)) return "Opera"
  if (/Chrome\//.test(userAgent)) return "Chrome"
  if (/Firefox\//.test(userAgent)) return "Firefox"
  if (/Safari\//.test(userAgent)) return "Safari"
  return undefined
}

function systemOf(userAgent: string): string | undefined {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS"
  if (/Android/.test(userAgent)) return "Android"
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS"
  if (/Windows/.test(userAgent)) return "Windows"
  if (/Linux/.test(userAgent)) return "Linux"
  return undefined
}

/**
 * The program behind a token's last request, from its untrusted user agent. Tokens mostly serve
 * the CLI and CI, so those come first; anything unrecognized stays unnamed.
 */
export function useDescribeClient(): (userAgent?: string) => string | undefined {
  const messages = useSettingsMessages().common
  return (userAgent) => {
    const agent = userAgent?.trim()
    if (!agent) return undefined
    if (/sixb/i.test(agent)) return "Sixb CLI"
    if (/curl/i.test(agent)) return "curl"
    if (/wget/i.test(agent)) return "wget"
    if (/GitHub-Hookshot|actions\//i.test(agent)) return "GitHub Actions"
    if (/node(?:\.js)?\/|undici|axios|got\//i.test(agent)) return "Node.js"
    if (/python|httpx|aiohttp/i.test(agent)) return "Python"
    if (/Go-http-client/i.test(agent)) return "Go"
    if (/PostmanRuntime/i.test(agent)) return "Postman"
    const browser = browserOf(agent)
    if (!browser) return undefined
    const system = systemOf(agent)
    return system ? messages.clientOn(browser, system) : browser
  }
}

export type DeviceKind = "desktop" | "phone" | "terminal"

/** A browser session's device: always named, even when its user agent is unknown. */
export function useDescribeDevice(): (session: {
  readonly userAgent?: string
  readonly clientName?: string
}) => { readonly label: string; readonly kind: DeviceKind } {
  const messages = useSettingsMessages().common
  return ({ userAgent, clientName }) => {
    if (clientName) {
      return { label: clientName, kind: /cli|sixb/i.test(clientName) ? "terminal" : "desktop" }
    }
    if (!userAgent) return { label: messages.unknownDevice, kind: "desktop" }
    const system = systemOf(userAgent)
    return {
      label: messages.clientOn(
        browserOf(userAgent) ?? messages.browser,
        system ?? messages.unknownSystem
      ),
      kind: system === "iOS" || system === "Android" ? "phone" : "desktop",
    }
  }
}

export function defaultExpiresOn(days = 90): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return dateToInputValue(date)
}

export function dateInputToIso(value: string): string {
  return new Date(`${value}T23:59:59.999Z`).toISOString()
}

function inputValueToDate(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10))
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function dateToInputValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// Layout: a section is a small heading over a panel of hairline-separated rows.
// ---------------------------------------------------------------------------

/** A titled block of a settings page: heading and actions over its panel. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  readonly title?: string
  readonly description?: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      {title || action ? (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[0.9375rem] leading-6 font-semibold tracking-[-0.01em]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** A white card on the page's sheet. Rows inside are separated by hairlines. */
export function Panel({
  toolbar,
  footer,
  children,
}: {
  readonly toolbar?: ReactNode
  readonly footer?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          {toolbar}
        </div>
      ) : null}
      <div className="divide-y divide-border">{children}</div>
      {footer ? (
        <div className="border-t border-border bg-muted/40 px-5 py-3 text-[0.8125rem] leading-5 text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  )
}

/** One row of a panel: a leading mark, its text, and trailing actions. */
export function PanelRow({
  leading,
  title,
  meta,
  trailing,
  onClick,
  muted,
}: {
  readonly leading?: ReactNode
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly trailing?: ReactNode
  readonly onClick?: () => void
  readonly muted?: boolean
}) {
  const body = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className={cn("min-w-0 flex-1", muted && "opacity-60")}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          {title}
        </div>
        {meta ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
    </>
  )

  if (onClick) {
    return (
      <div className="group flex items-center gap-3 pr-3 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center gap-3.5 py-3.5 pl-4 text-left outline-none focus-visible:bg-muted/60"
        >
          {body}
        </button>
        {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      {body}
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </div>
  )
}

/** Separates the facts on a row's second line. */
export function MetaDot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  )
}

/** A small tile holding an icon, leading a row or an empty state. */
export function IconTile({
  icon: Icon,
  size = "md",
}: {
  readonly icon: Icon
  readonly size?: "md" | "lg"
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center border border-border bg-background text-muted-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        size === "lg" ? "size-11 rounded-xl" : "size-9 rounded-lg"
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  )
}

/** A person's picture, or their initials on a soft disc. */
export function PersonAvatar({
  name,
  email,
  avatarUrl,
  size = "md",
}: {
  readonly name?: string
  readonly email: string
  readonly avatarUrl?: string
  readonly size?: "md" | "lg"
}) {
  const className = size === "lg" ? "size-12 text-base" : "size-9 text-[0.8125rem]"
  if (avatarUrl) {
    return (
      <img src={avatarUrl} alt="" className={cn("shrink-0 rounded-full object-cover", className)} />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-muted to-accent font-medium text-foreground/70 ring-1 ring-black/5 ring-inset select-none dark:ring-white/10",
        className
      )}
    >
      {initialsOf(name, email)}
    </span>
  )
}

/** Two letters for a name; one for an address, since its parts are not a first and last name. */
export function initialsOf(name: string | undefined, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase()
  if (words.length === 1) return (words[0]?.[0] ?? "?").toUpperCase()
  return (email.trim()[0] ?? "?").toUpperCase()
}

export type Tone = "ok" | "warn" | "info" | "muted"

const toneClasses: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  info: "bg-sky-500",
  muted: "bg-muted-foreground/50",
}

/** A short status in a quiet pill, led by a colored dot unless `tone` is omitted. */
export function Pill({ tone, children }: { readonly tone?: Tone; readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-[0.6875rem] font-medium whitespace-nowrap text-foreground/75">
      {tone ? (
        <span aria-hidden className={cn("size-1.5 rounded-full", toneClasses[tone])} />
      ) : null}
      {children}
    </span>
  )
}

/** The panel body while its rows load. */
export function PanelSkeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3.5 px-4 py-3.5">
          <span className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-40 animate-pulse rounded bg-muted" />
            <span className="h-2.5 w-64 max-w-full animate-pulse rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </>
  )
}

/** What a panel shows with nothing in it, or when it could not load. */
export function PanelEmpty({
  icon,
  title,
  description,
  action,
  tone = "muted",
}: {
  readonly icon: Icon
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly tone?: "muted" | "error"
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {tone === "error" ? (
        <IconTile icon={CircleAlert} size="lg" />
      ) : (
        <IconTile icon={icon} size="lg" />
      )}
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description ? (
        <p className="mt-1 max-w-[44ch] text-[0.8125rem] leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

/** Segmented tabs in a panel's toolbar, each with a count. */
export function ToolbarTabs<TTab extends string>({
  tabs,
  value,
  onChange,
}: {
  readonly tabs: readonly { readonly id: TTab; readonly label: string; readonly count?: number }[]
  readonly value: TTab
  readonly onChange: (tab: TTab) => void
}) {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] font-medium transition-colors",
            value === tab.id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="text-xs text-muted-foreground tabular-nums">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** A form field: label, control, optional hint. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: ReactNode
  readonly htmlFor?: string
  readonly hint?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium">
          {label}
        </label>
      ) : (
        <span className="text-[0.8125rem] font-medium">{label}</span>
      )}
      {children}
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function FormError({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-[0.8125rem] text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/** Copies `value`, says so for a moment, and explains when the browser refuses. */
export function CopyButton({ value }: { readonly value: string }) {
  const messages = useSettingsMessages().common
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState("copied")
      window.setTimeout(() => setState("idle"), 1600)
    } catch {
      setState("failed")
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={copy}
      title={state === "failed" ? messages.copyFailed : undefined}
      className="shrink-0 text-muted-foreground"
    >
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied" ? messages.copied : messages.copy}
    </Button>
  )
}

/** A value shown once, such as a new token, with a copy button. */
export function CopyField({ value }: { readonly value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-xs leading-6 break-all text-foreground">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  )
}

export function Warning({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function GroupPicker({
  disabled,
  groups,
  selectedGroupIds,
  lockedGroupIds = [],
  onChange,
  emptyMessage,
}: {
  readonly disabled?: boolean
  readonly groups: readonly AuthGroupOption[]
  readonly selectedGroupIds: readonly string[]
  /** Selected groups the identity provider manages, which cannot be unselected here. */
  readonly lockedGroupIds?: readonly string[]
  readonly onChange: (groupIds: string[]) => void
  readonly emptyMessage: string
}) {
  const messages = useSettingsMessages().common
  const selected = useMemo(() => new Set(selectedGroupIds), [selectedGroupIds])
  const locked = useMemo(() => new Set(lockedGroupIds), [lockedGroupIds])

  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyMessage}</p>
  }

  const toggle = (groupId: string) =>
    onChange(
      selected.has(groupId)
        ? selectedGroupIds.filter((selectedGroupId) => selectedGroupId !== groupId)
        : [...selectedGroupIds, groupId]
    )

  return (
    <div className="flex flex-wrap gap-1.5">
      {groups.map((group) => {
        const active = selected.has(group.id)
        const managed = locked.has(group.id)
        return (
          <button
            type="button"
            key={group.id}
            onClick={() => toggle(group.id)}
            disabled={disabled || managed}
            aria-pressed={active}
            title={managed ? messages.managedGroupHint : undefined}
            className={cn(
              "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border px-2.5 text-[0.8125rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "border-foreground/20 bg-foreground/[0.04] text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/15 hover:text-foreground",
              // A managed group is still one the member has: only its check shows it is fixed.
              managed && !disabled && "disabled:cursor-default disabled:opacity-100"
            )}
          >
            <span
              className={cn(
                "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                active && managed && "border-border bg-muted text-muted-foreground",
                active && !managed && "border-foreground bg-foreground text-background",
                !active && "border-foreground/25"
              )}
            >
              {active ? <Check className="size-2.5" strokeWidth={3} /> : null}
            </span>
            <span className="truncate">{groupLabel(group)}</span>
            {managed ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                <Link2 className="size-3" />
                {messages.identityProvider}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function GroupChips({
  groupIds,
  managedGroupIds = [],
  groupsById,
  emptyLabel,
}: {
  readonly groupIds: readonly string[]
  /** Groups the identity provider manages, marked with a link. */
  readonly managedGroupIds?: readonly string[]
  readonly groupsById: ReadonlyMap<string, AuthGroupOption>
  readonly emptyLabel?: string
}) {
  const messages = useSettingsMessages().common
  if (groupIds.length === 0) {
    return (
      <span className="text-[0.8125rem] text-muted-foreground">
        {emptyLabel ?? messages.noGroups}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {groupIds.map((groupId) => {
        const managed = managedGroupIds.includes(groupId)
        return (
          <span
            key={groupId}
            title={managed ? messages.managedGroupHint : undefined}
            className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[0.6875rem] font-medium whitespace-nowrap text-foreground/75"
          >
            {managed ? <Link2 className="size-3 text-muted-foreground" /> : null}
            {groupLabel(groupsById.get(groupId) ?? { id: groupId })}
          </span>
        )
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Expiry {
  readonly label: string
  readonly soon: boolean
}

function useExpiry(): (token: AccessToken) => Expiry {
  const messages = useSettingsMessages().token
  const format = useFormat()
  return (token) => {
    if (token.status === "revoked") {
      return {
        label: token.revokedAt
          ? messages.revokedOn(format.date(token.revokedAt))
          : messages.status.revoked,
        soon: false,
      }
    }
    if (token.status === "expired") {
      return { label: messages.expiredOn(format.date(token.expiresAt)), soon: false }
    }
    const days = Math.ceil((new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000)
    if (days <= 0) return { label: messages.expiresToday, soon: true }
    if (days === 1) return { label: messages.expiresTomorrow, soon: true }
    if (days <= 45) return { label: messages.expiresInDays(days), soon: days <= 14 }
    return { label: messages.expiresOn(format.date(token.expiresAt)), soon: false }
  }
}

/**
 * Token rows for a panel: active tokens first, then revoked and expired ones behind a toggle.
 * Renders the panel's empty state when there are none.
 */
export function TokenRows({
  tokens,
  groupsById,
  revokingTokenId,
  onRevoke,
  empty,
  showGroups = true,
}: {
  readonly tokens: readonly AccessToken[]
  readonly groupsById: ReadonlyMap<string, AuthGroupOption>
  readonly revokingTokenId: string | null
  readonly onRevoke: (tokenId: string) => void
  readonly empty: ReactNode
  /** Off where the groups already show nearby, such as a service account's sheet. */
  readonly showGroups?: boolean
}) {
  const messages = useSettingsMessages()
  const expiryOf = useExpiry()
  const describeClient = useDescribeClient()
  const format = useFormat()
  const [showInactive, setShowInactive] = useState(false)

  if (tokens.length === 0) return empty

  const active = tokens.filter((token) => token.status === "active")
  const inactive = tokens.filter((token) => token.status !== "active")
  const shown = showInactive ? [...active, ...inactive] : active

  return (
    <>
      {shown.map((token) => {
        const expiry = expiryOf(token)
        const isActive = token.status === "active"
        const client = describeClient(token.lastUsedUserAgent)
        const usage = token.lastUsedAt
          ? client
            ? messages.token.usedBy(format.relative(token.lastUsedAt), client)
            : messages.token.used(format.relative(token.lastUsedAt))
          : messages.token.neverUsed
        return (
          <PanelRow
            key={token.id}
            muted={!isActive}
            leading={<IconTile icon={KeyRound} />}
            title={
              <>
                <span className="truncate">{token.name}</span>
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {maskId(token.id, "tok_")}
                </span>
                {isActive ? null : (
                  <Pill tone="muted">
                    {token.status === "expired"
                      ? messages.token.status.expired
                      : messages.token.status.revoked}
                  </Pill>
                )}
              </>
            }
            meta={
              <>
                <span>{usage}</span>
                <MetaDot />
                <span className={cn(expiry.soon && "text-amber-700 dark:text-amber-300")}>
                  {expiry.label}
                </span>
              </>
            }
            trailing={
              <>
                {showGroups && (token.groupIds ?? []).length > 0 ? (
                  <span className="hidden md:inline-flex">
                    <GroupChips groupIds={token.groupIds ?? []} groupsById={groupsById} />
                  </span>
                ) : null}
                {isActive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revokingTokenId === token.id}
                    onClick={() => onRevoke(token.id)}
                    className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
                  >
                    {revokingTokenId === token.id
                      ? messages.common.revoking
                      : messages.common.revoke}
                  </Button>
                ) : null}
              </>
            }
          />
        )
      })}
      {inactive.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowInactive((shown) => !shown)}
          className="flex w-full items-center px-4 py-2.5 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          {showInactive
            ? messages.token.hideInactive
            : messages.token.showInactive(inactive.length)}
        </button>
      ) : null}
    </>
  )
}

const expirationPresets = [
  { id: "days30", days: 30 },
  { id: "days90", days: 90 },
  { id: "year", days: 365 },
] as const

function ExpirationPicker({
  disabled,
  value,
  onChange,
}: {
  readonly disabled?: boolean
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const messages = useSettingsMessages().token.form
  const locale = useLocale()
  const [customMode, setCustomMode] = useState(false)
  const [open, setOpen] = useState(false)
  const preset = customMode
    ? undefined
    : expirationPresets.find((candidate) => defaultExpiresOn(candidate.days) === value)
  const selectedDate = inputValueToDate(value)
  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
    : messages.selectDate
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const option = (selected: boolean) =>
    cn(
      "h-8 flex-1 rounded-md text-[0.8125rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      selected
        ? "bg-background text-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.08)]"
        : "text-muted-foreground hover:text-foreground"
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {expirationPresets.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            disabled={disabled}
            className={option(preset?.id === candidate.id)}
            onClick={() => {
              setCustomMode(false)
              onChange(defaultExpiresOn(candidate.days))
            }}
          >
            {messages.presets[candidate.id]}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          className={option(!preset)}
          onClick={() => setCustomMode(true)}
        >
          {messages.presets.custom}
        </button>
      </div>
      {preset ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarIcon className="size-3.5" />
          {messages.expiresOn(dateLabel)}
        </p>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className="justify-start font-normal"
            >
              <CalendarIcon className="text-muted-foreground" />
              {dateLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="single"
              selected={selectedDate}
              disabled={{ before: today }}
              onSelect={(date) => {
                if (!date) return
                setCustomMode(true)
                onChange(dateToInputValue(date))
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** Creates a token, then shows its value once. */
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
  const messages = useSettingsMessages()
  const form = messages.token.form
  const [name, setName] = useState("")
  const [expiresOn, setExpiresOn] = useState(defaultExpiresOn())
  const [selectedGroupIds, setSelectedGroupIds] = useState<readonly string[]>(defaultGroupIds)
  const [localError, setLocalError] = useState<string | null>(null)

  // Reset the form each time the dialog opens so it never reopens half filled.
  useEffect(() => {
    if (!open) return
    setName("")
    setExpiresOn(defaultExpiresOn())
    setSelectedGroupIds(defaultGroupIds)
    setLocalError(null)
  }, [open, defaultGroupIds])

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
      setLocalError(form.invalidDate)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 sm:max-w-[28rem]" showCloseButton={!created}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{messages.token.reveal.title}</DialogTitle>
              <DialogDescription>{messages.token.reveal.ready(created.name)}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <CopyField value={created.tokenValue} />
              <Warning>{messages.token.reveal.onlyOnce}</Warning>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {messages.common.done}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>
                {kind === "service" ? form.serviceTitle : form.personalTitle}
              </DialogTitle>
              <DialogDescription>
                {kind === "service" ? form.serviceDescription : form.personalDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-5">
              <Field label={form.name} htmlFor="token-name">
                <Input
                  id="token-name"
                  value={name}
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    kind === "service" ? form.servicePlaceholder : form.personalPlaceholder
                  }
                />
              </Field>
              <Field label={form.expiration}>
                <ExpirationPicker
                  value={expiresOn}
                  onChange={setExpiresOn}
                  disabled={isSubmitting}
                />
              </Field>
              <Field
                label={form.groups}
                hint={kind === "service" ? form.serviceGroupsHint : form.personalGroupsHint}
              >
                <GroupPicker
                  groups={groups}
                  selectedGroupIds={selectedGroupIds}
                  onChange={setSelectedGroupIds}
                  disabled={isSubmitting}
                  emptyMessage={form.personalNoGroups}
                />
              </Field>
              {localError || errorMessage ? (
                <FormError>{localError ?? errorMessage}</FormError>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                {messages.common.cancel}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? <Loader2 className="animate-spin" /> : null}
                {form.create}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
