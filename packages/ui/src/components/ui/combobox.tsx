"use client"

import { Button } from "@sixb/ui/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@sixb/ui/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components/ui/popover"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronsUpDown } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

export interface ComboboxOption {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

export function Combobox({
  id,
  value,
  options,
  onValueChange,
  placeholder = "Select an option...",
  searchPlaceholder = "Search...",
  emptyLabel = "No results found.",
  disabled = false,
  className,
  "aria-describedby": ariaDescribedBy,
  hasMore = false,
  loadingMore = false,
  loadingLabel = "Loading more...",
  loadMoreLabel = "Scroll to load more...",
  onLoadMore,
}: {
  readonly id?: string
  readonly value?: string
  readonly options: readonly ComboboxOption[]
  readonly onValueChange: (value: string) => void
  readonly placeholder?: string
  readonly searchPlaceholder?: string
  readonly emptyLabel?: string
  readonly disabled?: boolean
  readonly className?: string
  readonly "aria-describedby"?: string
  readonly hasMore?: boolean
  readonly loadingMore?: boolean
  readonly loadingLabel?: string
  readonly loadMoreLabel?: string
  readonly onLoadMore?: () => void
}) {
  const [open, setOpen] = useState(false)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value]
  )

  useEffect(() => {
    if (!open || !hasMore || loadingMore || !onLoadMore) return

    const element = loadMoreRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          onLoadMore()
        }
      },
      { rootMargin: "80px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, onLoadMore, open])

  const portalContainer = triggerRef.current?.closest<HTMLElement>("[data-slot='dialog-content']")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          id={id}
          ref={triggerRef}
          role="combobox"
          aria-expanded={open}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          className={cn("w-full justify-between bg-background", className)}
        >
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
            {selectedOption?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList
            className="overscroll-contain"
            style={{ maxHeight: "18rem", overflowY: "auto" }}
          >
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.description].filter(Boolean) as string[]}
                  disabled={option.disabled}
                  onSelect={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      option.value === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.description ? (
                    <span className="ml-auto max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {hasMore || loadingMore ? (
              <div
                ref={loadMoreRef}
                className="px-3 py-2 text-center text-xs text-muted-foreground"
              >
                {loadingMore ? loadingLabel : loadMoreLabel}
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
