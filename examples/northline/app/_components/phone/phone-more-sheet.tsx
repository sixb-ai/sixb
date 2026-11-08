import { useCurrentUser, useSections, useSignOut } from "@sixb/app"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  ThemePicker,
} from "@sixb/ui/components"
import { ChevronRight, Layers, LogOut, MessagesSquare } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { threadPath, threadTitle, useRecentThreads } from "../../_lib/agent-threads"
import { places } from "../../_lib/navigation"
import { initials } from "../ui"

type Icon = ComponentType<{ readonly className?: string }>

interface Row {
  readonly to: string
  readonly label: string
  readonly Icon: Icon
}

// The tab bar holds the first four places; everything else is here.
const GROUPS = [
  { label: "Operations", places: places.filter((p) => p.section === "operations" && !p.tab) },
  { label: "Business", places: places.filter((p) => p.section === "business" && !p.tab) },
]

const RECENT_THREADS = 4

/**
 * Everything beyond the tab bar, as a sheet that rises from the bottom: the account and its theme,
 * the remaining places, the latest conversations, Artifacts and the built-in sections, and sign
 * out. It takes the sidebar's place on phones, so any control that opens the sidebar opens this.
 */
export function PhoneMoreSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const sections = useSections()
  const { pathname } = useLocation()
  const close = () => onOpenChange(false)
  const isCurrent = (to: string) => pathname === to || pathname.startsWith(`${to}/`)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="phone-more-sheet">
        <DrawerTitle className="sr-only">More</DrawerTitle>
        <DrawerDescription className="sr-only">
          Every place in Northline Operations and your account.
        </DrawerDescription>

        <div className="phone-more-scroll">
          <AccountCard />

          {GROUPS.map((group) => (
            <Group key={group.label} label={group.label}>
              {group.places.map((place) => (
                <SheetRow
                  key={place.href}
                  to={place.href}
                  label={place.label}
                  Icon={place.icon}
                  current={isCurrent(place.href)}
                  onNavigate={close}
                />
              ))}
            </Group>
          ))}

          <RecentThreads current={pathname} onNavigate={close} />

          <Group label="Workspace">
            <SheetRow
              to="/artifacts"
              label="Artifacts"
              Icon={Layers}
              current={isCurrent("/artifacts")}
              onNavigate={close}
            />
            {sections.map((section) => (
              <SheetRow
                key={section.id}
                to={section.href}
                label={section.label}
                Icon={section.icon}
                current={isCurrent(section.href)}
                onNavigate={close}
              />
            ))}
          </Group>

          <SignOut />
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function Group({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="phone-more-group">
      <h2>{label}</h2>
      <ul>{children}</ul>
    </section>
  )
}

function SheetRow({
  to,
  label,
  Icon,
  current,
  onNavigate,
}: Row & { readonly current: boolean; readonly onNavigate: () => void }) {
  return (
    <li>
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={current ? "page" : undefined}
        className="phone-more-row"
      >
        <span className="phone-more-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="phone-more-label">{label}</span>
        <ChevronRight aria-hidden="true" className="phone-more-chevron" />
      </Link>
    </li>
  )
}

function RecentThreads({
  current,
  onNavigate,
}: {
  readonly current: string
  readonly onNavigate: () => void
}) {
  const { threads, loading } = useRecentThreads()
  if (loading || threads.length === 0) return null

  return (
    <Group label="Recents">
      {threads.slice(0, RECENT_THREADS).map((thread) => {
        const to = threadPath(thread.id)
        return (
          <li key={thread.id}>
            <Link
              to={to}
              onClick={onNavigate}
              aria-current={current === to ? "page" : undefined}
              className="phone-more-row"
            >
              <span className="phone-more-label">{threadTitle(thread)}</span>
              {thread.activeRunId ? (
                <span role="status" aria-label="Working" className="nl-working-dot" />
              ) : null}
            </Link>
          </li>
        )
      })}
      <SheetRow
        to="/threads"
        label="All threads"
        Icon={MessagesSquare}
        current={current === "/threads"}
        onNavigate={onNavigate}
      />
    </Group>
  )
}

function AccountCard() {
  const user = useCurrentUser()
  const name = user ? (user.displayName ?? user.email) : null

  return (
    <section className="phone-more-account">
      {user && name ? (
        <div className="phone-more-identity">
          <Avatar className="size-11">
            {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-primary text-[13px] font-medium text-primary-foreground">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-[16px] font-semibold text-foreground">{name}</p>
            {user.displayName ? (
              <p className="truncate text-[13px] text-muted-foreground">{user.email}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      <ThemePicker labels className="phone-more-theme" />
    </section>
  )
}

function SignOut() {
  const user = useCurrentUser()
  const signOut = useSignOut()
  if (!user) return null

  return (
    <button
      type="button"
      className="phone-more-signout"
      onClick={() => {
        signOut().catch((error: unknown) => {
          console.error("[Northline] Could not sign out:", error)
        })
      }}
    >
      <LogOut aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
      Sign out
    </button>
  )
}
