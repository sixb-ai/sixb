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
import { type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

const COMBOBOX_LOAD_MORE_THRESHOLD_PX = 80

function isNearScrollEnd(element: HTMLDivElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    COMBOBOX_LOAD_MORE_THRESHOLD_PX
  )
}

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
  loadMoreLabel = "Load more",
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
  const loadedOptionCountRef = useRef(options.length)
  const loadMorePendingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value]
  )

  useEffect(() => {
    const optionCountChanged = loadedOptionCountRef.current !== options.length
    if (!loadingMore || optionCountChanged) loadMorePendingRef.current = false
    loadedOptionCountRef.current = options.length
  }, [loadingMore, options.length])

  const requestLoadMore = useCallback(() => {
    if (!hasMore || loadingMore || loadMorePendingRef.current || !onLoadMore) return

    loadMorePendingRef.current = true
    try {
      onLoadMore()
    } catch (error) {
      loadMorePendingRef.current = false
      throw error
    }
  }, [hasMore, loadingMore, onLoadMore])

  const handleListScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (isNearScrollEnd(event.currentTarget)) requestLoadMore()
    },
    [requestLoadMore]
  )

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
            onScroll={handleListScroll}
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
              <CommandItem
                forceMount
                value="__sixb_load_more__"
                disabled={loadingMore}
                onSelect={requestLoadMore}
                className="justify-center rounded-none px-3 py-2 text-xs text-muted-foreground"
              >
                {loadingMore ? loadingLabel : loadMoreLabel}
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
