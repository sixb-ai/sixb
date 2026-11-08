import { searchObjectsOptions } from "@sixb/client/hooks"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { quotePath } from "../_lib/quotes"
import { casePath } from "../_lib/service-cases"

interface GlobalSearchProps {
  /** The sidebar's search row by default; `toolbar` is the phone top bar's icon button. */
  readonly placement?: "sidebar" | "toolbar"
}

export function GlobalSearch({ placement = "sidebar" }: GlobalSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const navigate = useNavigate()
  const results = useQuery({
    ...searchObjectsOptions({ query: { q: query || "_", limit: "12" } }),
    enabled: open && query.trim().length > 1,
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // On phones it fills the screen instead of floating (see phone/phone-navigation.css). The server
  // matches more fields than a result's label, so the dialog shows its results as they come.
  const dialog = (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
      shouldFilter={false}
      fullscreen
      className="northline-search"
    >
      <CommandInput
        placeholder="Search Northline Operations"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{query.length < 2 ? "Type to search." : "No matching records."}</CommandEmpty>
        <CommandGroup heading="Results">
          {(results.data?.items ?? []).map((item) => (
            <CommandItem
              key={`${item.ref.objectTypeId}:${item.ref.primaryId}`}
              value={`${item.label} ${item.ref.primaryId}`}
              onSelect={() => {
                navigate(resultPath(item.ref.objectTypeId, item.ref.primaryId))
                setOpen(false)
              }}
            >
              <Search className="size-4 text-muted-foreground" />
              <span>{item.label}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {item.ref.objectTypeId}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )

  if (placement === "toolbar") {
    return (
      <>
        <button
          type="button"
          aria-label="Search"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="phone-bar-action"
          onClick={() => setOpen(true)}
        >
          <Search className="size-[21px]" strokeWidth={1.8} aria-hidden="true" />
        </button>
        {dialog}
      </>
    )
  }

  return (
    <>
      <button type="button" className="nl-sidebar-row" onClick={() => setOpen(true)}>
        <Search />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      {dialog}
    </>
  )
}

function resultPath(objectTypeId: string, primaryId: string): string {
  const encoded = encodeURIComponent(primaryId)
  if (objectTypeId === "ServiceCase") return casePath(primaryId)
  if (objectTypeId === "Equipment") return `/equipment/${encoded}`
  if (objectTypeId === "CustomerAccount") return `/customers/${encoded}`
  if (objectTypeId === "Technician") return `/technicians/${encoded}`
  if (objectTypeId === "Quote") return quotePath(primaryId)
  if (objectTypeId === "ServiceContract") return "/contracts"
  if (objectTypeId === "WorkOrder" || objectTypeId === "ServiceVisit") return "/dispatch"
  return "/"
}
