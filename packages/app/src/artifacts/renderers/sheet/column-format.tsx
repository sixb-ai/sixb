import {
  checkFormula,
  columnFormulaType,
  type FormulaType,
  formulaFitsColumn,
  NUMERIC_COLUMN_TYPES,
  parseFormula,
  SHEET_COLUMN_TYPES,
  SHEET_HIGHLIGHTS,
  SHEET_TOTALS,
  type SheetColumnFormat,
  type SheetColumnType,
  type SheetHighlight,
  type SheetTotal,
} from "@sixb/core/artifacts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { CircleCheck, CircleX } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import { useArtifactMessages } from "../../messages"
import type { ColumnRefusal, ColumnSettings } from "./draft"

/** The column a dialog sets, as the draft holds it. */
export interface ColumnSubject {
  readonly name: string
  readonly format: SheetColumnFormat
  readonly description?: string
  readonly total?: SheetTotal
  /** The sheet's other columns, by name, with their types: what a formula may read. */
  readonly others: ReadonlyMap<string, SheetColumnType>
}

const AUTO = "auto"
const NONE = "none"

/**
 * A column's settings while the sheet is edited: its name, type and form, a total under it, what
 * it means, and the formula that computes it, checked as it is typed. Applying sets them as one
 * change; one the draft refuses says why and stays open.
 */
export function ColumnDialog({
  subject,
  focus,
  onApply,
  onClose,
}: {
  readonly subject: ColumnSubject
  /** What takes focus as the dialog opens: the name to rename, or the type to format. */
  readonly focus: "name" | "type"
  /** Sets the column; returns why it can't be, or null when it was. */
  readonly onApply: (settings: ColumnSettings) => ColumnRefusal | null
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages()
  const text = messages.column
  const id = useId()
  const [name, setName] = useState(subject.name)
  const [type, setType] = useState<SheetColumnType>(subject.format.type)
  const [currency, setCurrency] = useState(subject.format.currency ?? "USD")
  const [decimals, setDecimals] = useState(
    subject.format.decimals === undefined ? AUTO : String(subject.format.decimals)
  )
  const [compact, setCompact] = useState(subject.format.compact ?? false)
  const [signed, setSigned] = useState(subject.format.signed ?? false)
  const [highlight, setHighlight] = useState<string>(subject.format.highlight ?? NONE)
  const [total, setTotal] = useState<string>(subject.total ?? NONE)
  const [formula, setFormula] = useState(subject.format.formula ?? "")
  const [description, setDescription] = useState(subject.description ?? "")
  const [refusal, setRefusal] = useState<ColumnRefusal | null>(null)
  const numeric = NUMERIC_COLUMN_TYPES.includes(type)

  // The formula as it is typed: what it computes, or what is wrong with it.
  const check = ((): { computes: FormulaType } | { error: string } | null => {
    const written = formula.trim().replace(/^=/, "")
    if (!written) return null
    try {
      const types = new Map<string, FormulaType>(
        [...subject.others].map(([column, columnType]) => [column, columnFormulaType(columnType)])
      )
      const checked = checkFormula(parseFormula(written), types)
      if ("error" in checked) return { error: checked.error }
      return formulaFitsColumn(checked.type, type)
        ? { computes: checked.type }
        : { error: text.formulaType(text.computes[checked.type], columnLabel(type)) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })()

  function columnLabel(columnType: SheetColumnType): string {
    const label = messages.sheet.types[columnType]
    return typeof label === "string" ? label : label(currency)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const written = formula.trim().replace(/^=/, "")
    const format: SheetColumnFormat = {
      type,
      ...(type === "currency" ? { currency: currency.trim().toUpperCase() || "USD" } : {}),
      ...(numeric && decimals !== AUTO ? { decimals: Number(decimals) } : {}),
      ...((type === "number" || type === "currency") && compact ? { compact: true } : {}),
      ...(numeric && signed ? { signed: true } : {}),
      ...(numeric && highlight !== NONE ? { highlight: highlight as SheetHighlight } : {}),
      ...(type === "tag" && subject.format.tones ? { tones: subject.format.tones } : {}),
      ...(written ? { formula: written } : {}),
    }
    const refused = onApply({
      name,
      format,
      ...(description.trim() ? { description } : {}),
      ...(total !== NONE ? { total: total as SheetTotal } : {}),
    })
    if (refused) setRefusal(refused)
    else onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="gap-0 p-0 sm:max-w-[440px]">
        <form onSubmit={submit} className="flex max-h-[85vh] flex-col">
          <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-4">
            <DialogTitle>{text.title(subject.name)}</DialogTitle>
            <DialogDescription>{text.subtitle}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            <Row label={text.name} htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                value={name}
                autoFocus={focus === "name"}
                onChange={(event) => setName(event.target.value)}
              />
            </Row>
            <div className="grid grid-cols-2 gap-3">
              <Row label={text.type} htmlFor={`${id}-type`}>
                <Select value={type} onValueChange={(value) => setType(value as SheetColumnType)}>
                  <SelectTrigger id={`${id}-type`} className="w-full" autoFocus={focus === "type"}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHEET_COLUMN_TYPES.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry === "currency" ? text.currencyType : columnLabel(entry)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              {type === "currency" ? (
                <Row label={text.currency} htmlFor={`${id}-currency`}>
                  <Input
                    id={`${id}-currency`}
                    value={currency}
                    maxLength={3}
                    className="uppercase"
                    onChange={(event) => setCurrency(event.target.value)}
                  />
                </Row>
              ) : numeric ? (
                <Row label={text.decimals} htmlFor={`${id}-decimals`}>
                  <DecimalsSelect id={`${id}-decimals`} value={decimals} onChange={setDecimals} />
                </Row>
              ) : null}
            </div>
            {numeric ? (
              <div className="grid grid-cols-2 gap-3">
                {type === "currency" ? (
                  <Row label={text.decimals} htmlFor={`${id}-decimals`}>
                    <DecimalsSelect id={`${id}-decimals`} value={decimals} onChange={setDecimals} />
                  </Row>
                ) : null}
                <Row label={text.highlight} htmlFor={`${id}-highlight`}>
                  <Select value={highlight} onValueChange={setHighlight}>
                    <SelectTrigger id={`${id}-highlight`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{text.none}</SelectItem>
                      {SHEET_HIGHLIGHTS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {text.highlights[entry]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
              </div>
            ) : null}
            {numeric ? (
              <div className="flex flex-col gap-2.5 rounded-lg border border-border/70 px-3 py-2.5">
                {type !== "percent" ? (
                  <Toggle
                    id={`${id}-compact`}
                    label={text.compact}
                    hint={text.compactHint}
                    checked={compact}
                    onChange={setCompact}
                  />
                ) : null}
                <Toggle
                  id={`${id}-signed`}
                  label={text.signed}
                  hint={text.signedHint}
                  checked={signed}
                  onChange={setSigned}
                />
              </div>
            ) : null}
            <Row label={text.total} htmlFor={`${id}-total`}>
              <Select value={total} onValueChange={setTotal}>
                <SelectTrigger id={`${id}-total`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{text.none}</SelectItem>
                  {SHEET_TOTALS.filter((entry) => numeric || entry === "count").map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {messages.sheet[entry]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label={text.formula} htmlFor={`${id}-formula`} hint={text.formulaHint}>
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-serif text-sm text-muted-foreground italic"
                >
                  fx
                </span>
                <Input
                  id={`${id}-formula`}
                  value={formula}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={text.noFormula}
                  aria-invalid={check && "error" in check ? true : undefined}
                  className="pl-9 font-mono text-[13px]"
                  onChange={(event) => setFormula(event.target.value)}
                />
              </div>
              {check ? (
                <p
                  className={cn(
                    "flex items-start gap-1.5 text-xs",
                    "error" in check ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {"error" in check ? (
                    <CircleX className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <CircleCheck
                      className="mt-px size-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                  )}
                  {"error" in check
                    ? check.error
                    : text.computesInto(text.computes[check.computes])}
                </p>
              ) : null}
            </Row>
            <Row label={text.description} htmlFor={`${id}-description`}>
              <Textarea
                id={`${id}-description`}
                value={description}
                rows={2}
                maxLength={300}
                placeholder={text.descriptionHint}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Row>
          </div>
          <DialogFooter className="items-center gap-2 border-t border-border/70 px-5 py-3.5">
            {refusal ? (
              <p role="alert" className="mr-auto text-xs text-destructive">
                {refusalText(refusal, messages.column, (computes) =>
                  text.formulaType(text.computes[computes], columnLabel(type))
                )}
              </p>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              {text.cancel}
            </Button>
            <Button type="submit" disabled={!!check && "error" in check}>
              {text.apply}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A refusal in words: why the column can't change as asked. */
export function refusalText(
  refusal: ColumnRefusal,
  text: ReturnType<typeof useArtifactMessages>["column"],
  formulaType: (computes: FormulaType) => string
): string {
  switch (refusal.refused) {
    case "name-empty":
      return text.refusals.nameEmpty
    case "name-taken":
      return text.refusals.nameTaken(refusal.name)
    case "charted":
      return text.refusals.charted(refusal.by)
    case "computed-from":
      return text.refusals.computedFrom(refusal.by)
    case "values":
      return text.refusals.values(refusal.count)
    case "formula":
      return refusal.message
    case "formula-type":
      return formulaType(refusal.computes)
    case "formula-cycle":
      return text.refusals.cycle
  }
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string
  readonly htmlFor: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function DecimalsSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const text = useArtifactMessages().column
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>{text.automatic}</SelectItem>
        {["0", "1", "2", "3", "4"].map((entry) => (
          <SelectItem key={entry} value={entry}>
            {entry}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
