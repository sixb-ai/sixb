import { searchObjectsOptions } from "@sixb/client/hooks"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
} from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

export function GlobalSearch() {
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

  return (
    <>
      <button
        type="button"
        className="group flex h-9 w-full max-w-80 items-center gap-3 rounded-full px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span className="flex-1 max-sm:hidden">Search Northline</span>
        <span className="sm:hidden">Search</span>
        <Kbd className="h-6 bg-transparent px-1.5 text-sm group-hover:bg-background/70 max-sm:hidden">
          ⌘K
        </Kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Search Northline Operations"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {query.length < 2 ? "Type to search." : "No matching records."}
          </CommandEmpty>
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
    </>
  )
}

function resultPath(objectTypeId: string, primaryId: string): string {
  const encoded = encodeURIComponent(primaryId)
  if (objectTypeId === "ServiceCase") return `/service-cases/${encoded}`
  if (objectTypeId === "Equipment") return `/equipment/${encoded}`
  if (objectTypeId === "CustomerAccount") return `/customers/${encoded}`
  if (objectTypeId === "Technician") return `/technicians/${encoded}`
  if (objectTypeId === "Quote") return "/quotes"
  if (objectTypeId === "ServiceContract") return "/contracts"
  if (objectTypeId === "WorkOrder" || objectTypeId === "ServiceVisit") return "/dispatch"
  return "/"
}
