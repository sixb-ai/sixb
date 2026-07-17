import { Badge, Button } from "@sixb/ui/components"

export function ActionParamNullControl({
  paramName,
  isNull,
  disabled,
  onNullChange,
}: {
  paramName: string
  isNull: boolean
  disabled?: boolean
  onNullChange: (isNull: boolean) => void
}) {
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {isNull ? (
        <Badge variant="secondary" className="h-5 px-1.5 text-[9px] uppercase">
          Will send null
        </Badge>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px]"
        aria-label={`Send null for ${paramName}`}
        aria-pressed={isNull}
        disabled={disabled}
        onClick={() => onNullChange(!isNull)}
      >
        {isNull ? "Use a value" : "Set null"}
      </Button>
    </div>
  )
}
