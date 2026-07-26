"use client"

import { useId, useState } from "react"
import type {
  AddressCoordinates,
  AddressDraft,
  AddressProvider,
  AddressSuggestion,
} from "../../lib/address"
import { addressDraftFromSuggestion } from "../../lib/address"
import { cn } from "../../lib/utils"
import { Field, FieldLabel } from "../ui/field"
import { Input } from "../ui/input"
import { AddressAutocomplete } from "./address-autocomplete"

type AddressField = keyof AddressDraft

export type AddressFieldsProps = {
  readonly value: AddressDraft
  readonly onChange: (value: AddressDraft) => void
  readonly onSelect?: (suggestion: AddressSuggestion) => void
  readonly disabled?: boolean
  readonly className?: string
  readonly idPrefix?: string
  /** Which fields are marked required. Presentation only — validation stays with the form. */
  readonly required?: readonly AddressField[]
  /** Store the provider's region spelling ("New York") or its code ("NY"). */
  readonly regionFormat?: "name" | "code"
  readonly labels?: Partial<Record<AddressField | "search", string>>
  readonly searchPlaceholder?: string
  readonly showAttribution?: boolean
  readonly provider?: AddressProvider
  readonly minLength?: number
  readonly debounceMs?: number
  readonly limit?: number
  readonly lang?: string
  readonly countries?: readonly string[]
  readonly proximity?: AddressCoordinates
  readonly bbox?: readonly [number, number, number, number]
}

const DEFAULT_LABELS: Record<AddressField | "search", string> = {
  search: "Search address",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "State / region",
  postalCode: "Postal code",
  countryCode: "Country code",
}

const DEFAULT_REQUIRED: readonly AddressField[] = ["line1", "city", "postalCode", "countryCode"]

/**
 * Full address entry: provider-backed lookup that fills the structured fields
 * below, which stay editable so an address that no geocoder knows can still be
 * typed in.
 */
export function AddressFields({
  value,
  onChange,
  onSelect,
  disabled,
  className,
  idPrefix,
  required = DEFAULT_REQUIRED,
  regionFormat = "name",
  labels,
  searchPlaceholder,
  showAttribution,
  provider,
  minLength,
  debounceMs,
  limit,
  lang,
  countries,
  proximity,
  bbox,
}: AddressFieldsProps) {
  const generatedId = useId()
  const prefix = idPrefix ?? generatedId
  const [query, setQuery] = useState("")
  const text = { ...DEFAULT_LABELS, ...labels }

  function patch(field: AddressField, next: string) {
    onChange({
      ...value,
      [field]: field === "countryCode" ? next.slice(0, 2).toUpperCase() : next,
    })
  }

  return (
    <div className={cn("grid gap-3", className)}>
      <Field>
        <FieldLabel htmlFor={fieldId(prefix, "search")}>{text.search}</FieldLabel>
        <AddressAutocomplete
          id={fieldId(prefix, "search")}
          value={query}
          onValueChange={setQuery}
          onSelect={(suggestion) => {
            onChange(
              addressDraftFromSuggestion(suggestion, { previous: value, region: regionFormat })
            )
            onSelect?.(suggestion)
          }}
          disabled={disabled}
          placeholder={searchPlaceholder}
          showAttribution={showAttribution}
          provider={provider}
          minLength={minLength}
          debounceMs={debounceMs}
          limit={limit}
          lang={lang}
          countries={countries}
          proximity={proximity}
          bbox={bbox}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        {(["line1", "line2"] as const).map((field) => (
          <AddressInput
            key={field}
            className="sm:col-span-2"
            disabled={disabled}
            id={fieldId(prefix, field)}
            label={text[field]}
            onChange={(next) => patch(field, next)}
            required={required.includes(field)}
            value={value[field]}
          />
        ))}
        <AddressInput
          disabled={disabled}
          id={fieldId(prefix, "city")}
          label={text.city}
          onChange={(next) => patch("city", next)}
          required={required.includes("city")}
          value={value.city}
        />
        <AddressInput
          disabled={disabled}
          id={fieldId(prefix, "region")}
          label={text.region}
          onChange={(next) => patch("region", next)}
          required={required.includes("region")}
          value={value.region}
        />
        <AddressInput
          disabled={disabled}
          id={fieldId(prefix, "postalCode")}
          label={text.postalCode}
          onChange={(next) => patch("postalCode", next)}
          required={required.includes("postalCode")}
          value={value.postalCode}
        />
        <AddressInput
          disabled={disabled}
          id={fieldId(prefix, "countryCode")}
          label={text.countryCode}
          onChange={(next) => patch("countryCode", next)}
          placeholder="US"
          required={required.includes("countryCode")}
          value={value.countryCode}
        />
      </div>
    </div>
  )
}

function AddressInput({
  className,
  disabled,
  id,
  label,
  onChange,
  placeholder,
  required,
  value,
}: {
  readonly className?: string
  readonly disabled?: boolean
  readonly id: string
  readonly label: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly required?: boolean
  readonly value: string
}) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true">*</span> : null}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
      />
    </Field>
  )
}

function fieldId(prefix: string, field: string): string {
  return `${prefix}-${field}`
}
