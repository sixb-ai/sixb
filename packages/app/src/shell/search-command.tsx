import { searchObjectsOptions } from "@sixb/client/hooks"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sixb/ui/components"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Box, Search } from "lucide-react"
import { useDeferredValue, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useAppMessages } from "../locale"
import { objectHref } from "../pages/routes"
import { useSections, useSectionsEnabled } from "../sections/sections"
import { isExternal, type NavEntry, type NavItem } from "./nav-items"

export interface SearchCommandProps {
  /** The app's own pages, listed before the built-in sections'. `AppShell` passes its nav. */
  readonly pages?: readonly NavEntry[]
}

/**
 * A Search button for the sidebar, and ⌘K anywhere: the app's pages, every built-in section page
 * this person may open, and the project's objects as they type, each opening its page. Shared
 * links, which open one page, leave it out.
 */
export function SearchCommand({ pages = [] }: SearchCommandProps) {
  const messages = useAppMessages().search
  const navigate = useNavigate()
  const sections = useSections()
  const enabled = useSectionsEnabled()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const term = useDeferredValue(query.trim())
  const searching = term.length > 1
  const objects = useQuery({
    ...searchObjectsOptions({ query: { q: term, limit: "8" } }),
    enabled: enabled && open && searching,
    // Results stay while the next ones load, so the list does not jump on every keystroke.
    placeholderData: keepPreviousData,
    retry: false,
  })

  useEffect(() => {
    if (!enabled) return
    const toggle = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", toggle)
    return () => window.removeEventListener("keydown", toggle)
  }, [enabled])

  const go = (href: string) => {
    setOpen(false)
    setQuery("")
    if (isExternal(href)) window.location.assign(href)
    else navigate(href)
  }
  if (!enabled) return null
  const appPages = pages.flatMap((entry): readonly NavItem[] =>
    "group" in entry ? entry.items : [entry]
  )

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={messages.label}
            onClick={() => setOpen(true)}
            className="border border-sidebar-border text-sidebar-foreground/80 hover:border-foreground/15"
          >
            <Search />
            <span>{messages.label}</span>
            <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">⌘K</Kbd>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
        title={messages.label}
        className="max-w-xl rounded-xl"
      >
        <CommandInput value={query} onValueChange={setQuery} placeholder={messages.placeholder} />
        <CommandList className="max-h-[min(28rem,70vh)]">
          <CommandEmpty>{objects.isFetching ? messages.searching : messages.empty}</CommandEmpty>
          {searching && objects.data && objects.data.items.length > 0 ? (
            <CommandGroup heading={messages.objects}>
              {objects.data.items.map((item) => (
                <CommandItem
                  key={`${item.ref.objectTypeId}:${item.ref.primaryId}`}
                  value={`object:${item.ref.objectTypeId}:${item.ref.primaryId}`}
                  // The server matched these; the typed text keeps them through cmdk's own filter.
                  keywords={[item.label, query]}
                  onSelect={() => go(objectHref(item.ref.objectTypeId, item.ref.primaryId))}
                >
                  <Box />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.ref.objectTypeId}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {appPages.length > 0 ? (
            <CommandGroup heading={messages.pages}>
              {appPages.map((page) => (
                <PageItem key={page.href} page={page} onSelect={go} />
              ))}
            </CommandGroup>
          ) : null}
          {sections.map((section) => (
            <CommandGroup key={section.id} heading={section.label}>
              {section.pages
                .flatMap((entry) => ("group" in entry ? entry.items : [entry]))
                .map((page) => (
                  <PageItem key={page.href} page={page} keywords={[section.label]} onSelect={go} />
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  )
}

function PageItem({
  page,
  keywords,
  onSelect,
}: {
  readonly page: NavItem
  readonly keywords?: string[]
  readonly onSelect: (href: string) => void
}) {
  return (
    <CommandItem
      value={`page:${page.href}`}
      keywords={[page.label, ...(keywords ?? [])]}
      onSelect={() => onSelect(page.href)}
    >
      {page.icon ? <page.icon /> : null}
      <span>{page.label}</span>
    </CommandItem>
  )
}
