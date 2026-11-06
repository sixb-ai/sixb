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
        className="group flex h-10 w-full items-center gap-2.5 rounded-[10px] border border-black/[0.07] bg-card px-3 text-left text-[14px] text-muted-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:border-white/[0.08]"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" strokeWidth={1.8} />
        <span className="flex-1">Search</span>
        <Kbd className="h-5 bg-transparent px-1 text-[12px] text-muted-foreground">⌘K</Kbd>
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
