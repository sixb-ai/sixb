import type { ObjectQueryFacetResult } from "@sixb/client"
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { formatCount, formatValue } from "../../lib/formatValue"
import {
  arrayItemSchema,
  createFilterId,
  enumValues,
  filterHasValue,
  getOperatorsForProperty,
  getPropertyLabel,
  getQuickFilterValues,
  isBooleanSchema,
  isDateSchema,
  isNumberSchema,
  operatorLabels,
  operatorRequiresValue,
  parseValueForSchema,
  type QueryFilter,
  type QueryFilterOperator,
  type QueryProperty,
  schemaType,
} from "../../lib/objects/objectQuery"

export function ObjectFilterPopover({
  properties,
  filters,
  facetResults,
  onAddFilter,
}: {
  properties: QueryProperty[]
  filters: QueryFilter[]
  facetResults: ObjectQueryFacetResult[]
  onAddFilter: (filter: QueryFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? "")
  const selectedProperty = properties.find((property) => property.id === propertyId)
  const operatorOptions = selectedProperty ? getOperatorsForProperty(selectedProperty) : []
  const [operator, setOperator] = useState<QueryFilterOperator>(operatorOptions[0] ?? "eq")
  const [rawValue, setRawValue] = useState("")

  useEffect(() => {
    if (properties.length === 0) {
      setPropertyId("")
      return
    }
    if (!properties.some((property) => property.id === propertyId)) {
      const nextProperty = properties[0]
      setPropertyId(nextProperty.id)
      setOperator(getOperatorsForProperty(nextProperty)[0] ?? "eq")
      setRawValue("")
    }
  }, [properties, propertyId])

  useEffect(() => {
    if (operatorOptions.length === 0) return
    if (!operatorOptions.includes(operator)) {
      setOperator(operatorOptions[0])
      setRawValue("")
    }
  }, [operator, operatorOptions])

  const requiresValue = operatorRequiresValue(operator)
  const valueSchema =
    selectedProperty && operator === "contains" && schemaType(selectedProperty.schema) === "array"
      ? arrayItemSchema(selectedProperty.schema)
      : selectedProperty?.schema
  const parsedValue = requiresValue
    ? parseValueForSchema(valueSchema, rawValue)
    : ({ ok: true, value: undefined } as const)
  const quickValues = selectedProperty
    ? getQuickFilterValues(selectedProperty, valueSchema, facetResults).filter(
        (option) => !filterHasValue(filters, selectedProperty.id, option.value)
      )
    : []
  const quickValuesOnly = Boolean(
    valueSchema &&
      (enumValues(valueSchema) || isBooleanSchema(valueSchema)) &&
      quickValues.length > 0
  )
  const canAdd = Boolean(
    selectedProperty && (!requiresValue || (rawValue.trim().length > 0 && parsedValue.ok))
  )

  const addFilter = (input?: { value: unknown }) => {
    if (!selectedProperty) return
    const resolvedValue = input ? input.value : parsedValue.ok ? parsedValue.value : undefined
    if (operatorRequiresValue(operator) && !input && !canAdd) return
    if (operatorRequiresValue(operator) && !input && !parsedValue.ok) return
    onAddFilter({
      id: createFilterId(),
      propertyId: selectedProperty.id,
      operator,
      ...(operatorRequiresValue(operator) ? { value: resolvedValue } : {}),
    })
    setRawValue("")
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 rounded-md"
          disabled={properties.length === 0}
        >
          <Plus />
          Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Create filter</p>
          <p className="text-xs text-muted-foreground">Choose a field, condition, and value.</p>
        </div>

        <div className="grid gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Field
          </p>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg bg-muted/45 p-1">
            {properties.map((property) => {
              const selected = property.id === propertyId
              return (
                <button
                  key={property.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    selected
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                  )}
                  onClick={() => {
                    setPropertyId(property.id)
                    setOperator(getOperatorsForProperty(property)[0] ?? "eq")
                    setRawValue("")
                  }}
                >
                  <span className="min-w-0 truncate">{getPropertyLabel(property)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        "font-mono text-[10px]",
                        selected ? "text-background/70" : "text-muted-foreground"
                      )}
                    >
                      {property.id}
                    </span>
                    {selected ? <Check className="size-3.5" /> : null}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Condition
          </p>
          <Select
            value={operator}
            onValueChange={(value) => {
              setOperator(value as QueryFilterOperator)
              setRawValue("")
            }}
          >
            <SelectTrigger size="sm" aria-label="Filter operator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operatorOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {operatorLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {requiresValue ? (
            <>
              <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Value
              </p>
              {quickValues.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {quickValues.map((option) => (
                    <button
                      key={String(option.value)}
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-sm text-foreground transition-colors hover:bg-foreground hover:text-background"
                      onClick={() => addFilter({ value: option.value })}
                    >
                      <span>{option.label}</span>
                      {typeof option.count === "number" ? (
                        <span className="tabular-nums opacity-65">{formatCount(option.count)}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {!quickValuesOnly ? (
                <FilterValueInput
                  schema={valueSchema}
                  value={rawValue}
                  onValueChange={setRawValue}
                  onSubmit={() => addFilter()}
                />
              ) : null}
            </>
          ) : (
            <div className="mt-1 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              This operator does not need a value.
            </div>
          )}

          {requiresValue && !parsedValue.ok && rawValue.trim().length > 0 ? (
            <p className="text-xs text-destructive">{parsedValue.error}</p>
          ) : null}
        </div>

        {!quickValuesOnly ? (
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={!canAdd}
            onClick={() => addFilter()}
          >
            Apply filter
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">Choose a value to apply.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

function FilterValueInput({
  schema,
  value,
  onValueChange,
  onSubmit,
}: {
  schema: unknown
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  const values = enumValues(schema)
  if (values) {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" aria-label="Filter value">
          <SelectValue placeholder="Value" />
        </SelectTrigger>
        <SelectContent>
          {values.map((option) => (
            <SelectItem key={String(option)} value={String(option)}>
              {formatValue(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (isBooleanSchema(schema)) {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" aria-label="Filter value">
          <SelectValue placeholder="Value" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">True</SelectItem>
          <SelectItem value="false">False</SelectItem>
        </SelectContent>
      </Select>
    )
  }

  return (
    <Input
      type={isNumberSchema(schema) ? "number" : "text"}
      value={value}
      autoFocus
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit()
      }}
      placeholder={isDateSchema(schema) ? "2026-12-31" : "Value"}
    />
  )
}
