"use client"

import { MapPinIcon, SearchIcon } from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useAddressLookup } from "../../hooks/use-address-lookup"
import type { AddressCoordinates, AddressProvider, AddressSuggestion } from "../../lib/address"
import { formatAddress } from "../../lib/address"
import { cn } from "../../lib/utils"
import { Input } from "../ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover"
import { Spinner } from "../ui/spinner"

export type AddressAutocompleteProps = {
  /** Current text in the field. */
  readonly value: string
  readonly onValueChange: (value: string) => void
  /** Fires with the completed suggestion and the text written into the field. */
  readonly onSelect?: (suggestion: AddressSuggestion, formatted: string) => void
  /** Fires when editing ends — on blur and after a selection. For inline editors. */
  readonly onCommit?: (value: string) => void
  /** Fires when the user presses Escape. Suppresses the pending `onCommit`. */
  readonly onCancel?: () => void
  readonly id?: string
  readonly className?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly autoFocus?: boolean
  readonly "aria-label"?: string
  readonly "aria-describedby"?: string
  readonly provider?: AddressProvider
  readonly minLength?: number
  readonly debounceMs?: number
  readonly limit?: number
  readonly lang?: string
  readonly countries?: readonly string[]
  readonly proximity?: AddressCoordinates
  readonly bbox?: readonly [number, number, number, number]
  readonly emptyLabel?: string
  readonly loadingLabel?: string
  /** Text written into the field on selection. Defaults to a one-line address. */
  readonly formatSelection?: (suggestion: AddressSuggestion) => string
  readonly renderSuggestion?: (suggestion: AddressSuggestion) => React.ReactNode
  readonly showAttribution?: boolean
}

/**
 * Free-text address field with provider-backed suggestions.
 *
 * Implements the combobox pattern: results are a labelled listbox driven from the
 * input with arrow keys, Enter, and Escape, and the input keeps focus throughout.
 */
export function AddressAutocomplete({
  value,
  onValueChange,
  onSelect,
  onCommit,
  onCancel,
  id,
  className,
  placeholder = "Search for an address…",
  disabled = false,
  autoFocus,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  provider,
  minLength = 3,
  debounceMs,
  limit,
  lang,
  countries,
  proximity,
  bbox,
  emptyLabel = "No addresses found.",
  loadingLabel = "Searching addresses…",
  formatSelection = (suggestion) => formatAddress(suggestion),
  renderSuggestion,
  showAttribution = true,
}: AddressAutocompleteProps) {
  const generatedId = useId()
  const inputId = id ?? `${generatedId}-address`
  const listboxId = `${generatedId}-listbox`

  const [open, setOpen] = useState(false)
  // Tracked by id rather than index so a new result set cannot leave the
  // highlight pointing at a different address.
  const [activeId, setActiveId] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  const selectingRef = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const eligible = !disabled && value.trim().length >= minLength
  const lookup = useAddressLookup({
    query: value,
    enabled: open && !disabled,
    provider,
    minLength,
    debounceMs,
    limit,
    lang,
    countries,
    proximity,
    bbox,
  })
  const { suggestions, loading, error, attribution, select } = lookup
  const showList = open && eligible

  const activeIndex = activeId === null ? -1 : suggestions.findIndex((s) => s.id === activeId)
  const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined

  // Matching on the data attribute rather than a selector avoids escaping
  // provider ids, which contain colons and commas.
  useEffect(() => {
    if (!activeId) return
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-suggestion-id]")
    rows?.forEach((row) => {
      if (row.dataset.suggestionId === activeId) row.scrollIntoView({ block: "nearest" })
    })
  }, [activeId])

  const choose = useCallback(
    async (suggestion: AddressSuggestion) => {
      if (selectingRef.current) return
      selectingRef.current = true
      setOpen(false)
      setActiveId(null)
      try {
        const resolved = await select(suggestion)
        const formatted = formatSelection(resolved)
        onValueChange(formatted)
        onSelect?.(resolved, formatted)
        onCommit?.(formatted)
      } finally {
        selectingRef.current = false
      }
    },
    [select, formatSelection, onValueChange, onSelect, onCommit]
  )

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (!open && !onCancel) return
      event.preventDefault()
      setOpen(false)
      setActiveId(null)
      if (onCancel) {
        cancelledRef.current = true
        onCancel()
      }
      return
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!eligible) return
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (suggestions.length === 0) return
      const step = event.key === "ArrowDown" ? 1 : -1
      const next =
        activeIndex < 0
          ? step === 1
            ? 0
            : suggestions.length - 1
          : (activeIndex + step + suggestions.length) % suggestions.length
      setActiveId(suggestions[next]?.id ?? null)
      return
    }

    if (event.key === "Enter") {
      if (!showList || !activeSuggestion) return
      event.preventDefault()
      void choose(activeSuggestion)
      return
    }

    if (event.key === "Tab" && open) {
      setOpen(false)
      setActiveId(null)
    }
  }

  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined

  return (
    <Popover open={showList} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn("relative min-w-0", className)}>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value)
              if (!disabled) setOpen(true)
            }}
            onFocus={() => {
              cancelledRef.current = false
              if (!disabled) setOpen(true)
            }}
            onBlur={() => {
              setOpen(false)
              setActiveId(null)
              if (cancelledRef.current) {
                cancelledRef.current = false
                return
              }
              onCommit?.(value)
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 pr-9 pl-9"
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
          />
          {loading ? (
            <Spinner className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />
          ) : null}
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={4}
        // The input owns focus and keyboard handling; the popover must not take it.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[var(--radix-popover-trigger-width,var(--radix-popper-anchor-width))] overflow-hidden p-0"
      >
        <div ref={listRef} id={listboxId} role="listbox" aria-label="Address suggestions">
          {suggestions.length > 0 ? (
            <div className="max-h-72 overflow-y-auto p-1">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-suggestion-id={suggestion.id}
                  // Keeps focus in the input so blur-commit does not race the click.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveId(suggestion.id)}
                  onClick={() => void choose(suggestion)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                  )}
                >
                  {renderSuggestion ? (
                    renderSuggestion(suggestion)
                  ) : (
                    <>
                      <MapPinIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate font-medium leading-5">{suggestion.label}</span>
                        {suggestion.description ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {suggestion.description}
                          </span>
                        ) : null}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 py-2.5 text-sm text-muted-foreground">
              {loading ? loadingLabel : (error ?? emptyLabel)}
            </p>
          )}

          {showAttribution && attribution ? (
            <p className="border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground">
              {attribution}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
