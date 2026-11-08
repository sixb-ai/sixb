import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  ThemePicker,
  useSidebar,
} from "@sixb/ui/components"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { ChevronRight, Layers, LogOut } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { useAppMessages } from "../../locale"
import { useSections } from "../../sections/sections"
import { useCurrentUser, useSignOut } from "../../session"
import { isCurrentItem, isExternal, type NavEntry, type NavItem } from "../nav-items"
import { initials } from "../user-menu"

const ARTIFACTS_HREF = "/artifacts"

export interface PhoneMoreSheetProps {
  /** The app's places; those in the tab bar are left out. */
  readonly nav: readonly NavEntry[]
  /** More of the app's own, after its places, such as recent conversations. */
  readonly children?: ReactNode
}

/**
 * Everything beyond the tab bar, as a sheet that rises from the bottom: the account and its theme,
 * the places the tab bar doesn't hold, Artifacts and the built-in sections, and sign out. It takes
 * the sidebar's place on a phone and opens with it, so anything that opens the sidebar, the tab
 * bar's More and ⌘B included, opens this.
 */
export function PhoneMoreSheet({ nav, children }: PhoneMoreSheetProps) {
  const { openMobile, setOpenMobile } = useSidebar()
  const { pathname } = useLocation()
  const sections = useSections()
  const messages = useAppMessages()
  const close = () => setOpenMobile(false)

  return (
    <Drawer open={openMobile} onOpenChange={setOpenMobile}>
      <DrawerContent className="phone-more-sheet">
        <DrawerTitle className="sr-only">{messages.phone.more}</DrawerTitle>
        <DrawerDescription className="sr-only">{messages.phone.moreDescription}</DrawerDescription>
        <div className="phone-more-scroll">
          <AccountCard />
          {moreGroups(nav).map((group, index) => (
            <PhoneMoreGroup key={group.label ?? `group-${index}`} label={group.label}>
              {group.items.flatMap((item) => [
                <PhoneMoreRow
                  key={item.href}
                  to={item.href}
                  label={item.label}
                  icon={item.icon}
                  trailing={item.badge}
                  current={isCurrentItem(pathname, item)}
                  onNavigate={close}
                />,
                // A place's own pages follow it, set in as the sidebar sets them under it.
                ...(item.items ?? []).map((child) => (
                  <PhoneMoreRow
                    key={child.href}
                    to={child.href}
                    label={child.label}
                    trailing={child.badge}
                    current={isCurrentItem(pathname, child)}
                    onNavigate={close}
                    nested
                  />
                )),
              ])}
            </PhoneMoreGroup>
          ))}
          {children}
          <PhoneMoreGroup label={messages.phone.workspace}>
            <PhoneMoreRow
              to={ARTIFACTS_HREF}
              label={messages.artifacts}
              icon={Layers}
              current={isCurrentItem(pathname, { href: ARTIFACTS_HREF })}
              onNavigate={close}
            />
            {sections.map((section) => (
              <PhoneMoreRow
                key={section.id}
                to={section.href}
                label={section.label}
                icon={section.icon}
                current={isCurrentItem(pathname, { href: section.href })}
                onNavigate={close}
              />
            ))}
          </PhoneMoreGroup>
          <SignOut />
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/** A labelled group of rows in the More sheet. */
export function PhoneMoreGroup({
  label,
  children,
}: {
  readonly label?: string
  readonly children: ReactNode
}) {
  return (
    <section className="phone-more-group">
      {label ? <h2>{label}</h2> : null}
      <ul>{children}</ul>
    </section>
  )
}

/** One row in the More sheet: an optional icon, the label and a chevron. A link to another site
 * opens in a new tab, as the sidebar's do. */
export function PhoneMoreRow({
  to,
  label,
  icon: Icon,
  current,
  trailing,
  nested,
  onNavigate,
}: {
  readonly to: string
  readonly label: ReactNode
  readonly icon?: ComponentType<{ readonly className?: string }>
  readonly current?: boolean
  /** Shown before the chevron, such as a working indicator. */
  readonly trailing?: ReactNode
  /** One of a place's own pages, set in under it. */
  readonly nested?: boolean
  readonly onNavigate?: () => void
}) {
  const { setOpenMobile } = useSidebar()
  const onClick = onNavigate ?? (() => setOpenMobile(false))
  const content = (
    <>
      {Icon ? (
        <span className="phone-more-icon" aria-hidden="true">
          <Icon />
        </span>
      ) : null}
      <span className="phone-more-label">{label}</span>
      {trailing}
      <ChevronRight aria-hidden="true" className="phone-more-chevron" />
    </>
  )
  return (
    <li>
      {isExternal(to) ? (
        <a
          href={to}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClick}
          className="phone-more-row"
          data-nested={nested || undefined}
        >
          {content}
        </a>
      ) : (
        <Link
          to={to}
          onClick={onClick}
          aria-current={current ? "page" : undefined}
          className="phone-more-row"
          data-nested={nested || undefined}
        >
          {content}
        </Link>
      )}
    </li>
  )
}

function AccountCard() {
  const user = useCurrentUser()
  const theme = useOptionalTheme()
  const name = user ? (user.displayName ?? user.email) : null
  if (!name && !theme) return null

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
      {theme ? <ThemePicker labels className="phone-more-theme" /> : null}
    </section>
  )
}

function SignOut() {
  const user = useCurrentUser()
  const signOut = useSignOut()
  const messages = useAppMessages()
  if (!user) return null

  return (
    <button
      type="button"
      className="phone-more-signout"
      onClick={() => {
        signOut().catch((error: unknown) => {
          console.error("[SixbApp] Could not sign out:", error)
        })
      }}
    >
      <LogOut aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
      {messages.userMenu.signOut}
    </button>
  )
}

/** The places the tab bar leaves to More, in their groups; places before any group share one. */
function moreGroups(nav: readonly NavEntry[]) {
  const groups: { label?: string; items: NavItem[] }[] = []
  for (const entry of nav) {
    if ("group" in entry) {
      const items = entry.items.filter((item) => !item.tab)
      if (items.length) groups.push({ label: entry.group, items })
    } else if (!entry.tab) {
      const last = groups.at(-1)
      if (last && last.label === undefined) last.items.push(entry)
      else groups.push({ items: [entry] })
    }
  }
  return groups
}
