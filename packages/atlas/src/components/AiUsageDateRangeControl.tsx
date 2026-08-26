import { Button, Calendar, Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { CalendarRange } from "lucide-react"
import { useState } from "react"

interface AiUsageDateRangeControlProps {
  readonly from: Date
  readonly through: Date
  readonly label: string
  readonly active: boolean
  readonly onApply: (from: Date, through: Date) => void
}

interface SelectedDateRange {
  readonly from: Date | undefined
  readonly to?: Date
}

export function AiUsageDateRangeControl({
  from,
  through,
  label,
  active,
  onApply,
}: AiUsageDateRangeControlProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<SelectedDateRange>(() => selectedRange(from, through))
  const today = localDayStart(new Date())
  const invalid =
    selected.from === undefined ||
    selected.to === undefined ||
    selected.from.getTime() > selected.to.getTime() ||
    selected.to.getTime() > today.getTime()

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setSelected(selectedRange(from, through))
        setOpen(nextOpen)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "outline"}
          size="sm"
          className="max-w-full justify-start gap-2 bg-card px-2.5 font-normal"
        >
          <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Custom date range</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Select the first and last UTC day to include in the report.
          </p>
        </div>
        <Calendar
          mode="range"
          selected={selected}
          defaultMonth={selected.from ?? through}
          disabled={{ after: today }}
          onSelect={(range) => setSelected(range ?? { from: undefined })}
        />
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={invalid}
            onClick={() => {
              if (!selected.from || !selected.to || invalid) return
              onApply(selected.from, selected.to)
              setOpen(false)
            }}
          >
            Apply range
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function selectedRange(from: Date, through: Date): SelectedDateRange {
  return { from: localDayStart(from), to: localDayStart(through) }
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}
