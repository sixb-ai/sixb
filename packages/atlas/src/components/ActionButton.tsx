import type { ActionParam, ObjectAction } from "@sixb/client"
import { executeAction as executeActionRequest } from "@sixb/client"
import {
  Badge,
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
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

type ActionParams = Record<string, string | number | boolean>

interface ActionButtonProps {
  objectId: string
  actionId: string
  action: ObjectAction
  tone?: "default" | "primary" | "danger"
  size?: "compact" | "prominent"
  requireConfirm?: boolean
}

interface ActionParamsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: ObjectAction
  actionId: string
  onSubmit: (params: ActionParams) => void
}

function ActionParamsDialog({
  open,
  onOpenChange,
  action,
  actionId,
  onSubmit,
}: ActionParamsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({})

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const params: ActionParams = {}
    for (const [key, def] of Object.entries(action.params ?? {})) {
      const value = values[key]
      if (value !== undefined && value !== "") {
        if (def.type === "number") {
          params[key] = Number(value)
        } else if (def.type === "boolean") {
          params[key] = value === "true"
        } else {
          params[key] = value
        }
      }
    }
    onSubmit(params)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="capitalize">{actionId.replace(/-/g, " ")}</DialogTitle>
          {action.description ? <DialogDescription>{action.description}</DialogDescription> : null}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {Object.entries(action.params ?? {}).map(([key, def]: [string, ActionParam]) => (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor={`action-param-${key}`} className="text-xs">
                  {key}
                </Label>
                {def.required ? (
                  <Badge variant="outline" className="h-4 px-1 py-0 text-[8px] uppercase">
                    Required
                  </Badge>
                ) : null}
              </div>
              {def.description ? (
                <p className="text-[11px] text-muted-foreground">{def.description}</p>
              ) : null}
              {def.enum ? (
                <Select
                  value={values[key] ?? ""}
                  onValueChange={(value) => setValues({ ...values, [key]: value })}
                  required={def.required}
                >
                  <SelectTrigger id={`action-param-${key}`} className="w-full">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {def.enum.map((opt) => (
                      <SelectItem key={String(opt)} value={String(opt)}>
                        {String(opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : def.type === "boolean" ? (
                <Select
                  value={values[key] ?? ""}
                  onValueChange={(value) => setValues({ ...values, [key]: value })}
                  required={def.required}
                >
                  <SelectTrigger id={`action-param-${key}`} className="w-full">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`action-param-${key}`}
                  type={def.type === "number" ? "number" : "text"}
                  value={values[key] ?? ""}
                  onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  required={def.required}
                  placeholder={`Enter ${key}...`}
                />
              )}
            </div>
          ))}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Run</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ActionButton({
  objectId,
  actionId,
  action,
  tone = "default",
  size = "compact",
  requireConfirm,
}: ActionButtonProps) {
  const navigate = useNavigate()
  const [isExecuting, setIsExecuting] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message?: string } | null>(null)

  const hasRequiredParams = Object.values(action.params ?? {}).some((p: ActionParam) => p.required)
  const shouldConfirm = requireConfirm ?? tone === "danger"

  const runAction = async (params?: ActionParams) => {
    if (shouldConfirm) {
      const confirmed = window.confirm(`Run "${actionId.replace(/-/g, " ")}" on ${objectId}?`)
      if (!confirmed) return
    }

    setIsExecuting(true)
    setResult(null)

    try {
      const response = await executeActionRequest({
        path: { objectId, actionId },
        body: { params },
      })

      if (response.data?.success && response.data.runId) {
        setResult({ success: true })
        navigate(`/actions/runs/${response.data.runId}`)
      } else if (response.data?.success) {
        setResult({ success: true })
        setTimeout(() => setResult(null), 2000)
      } else {
        setResult({ success: false, message: response.data?.error ?? "Action failed" })
        setTimeout(() => setResult(null), 3000)
      }
    } catch (error) {
      setResult({
        success: false,
        message: error instanceof Error ? error.message : "Action failed",
      })
      setTimeout(() => setResult(null), 3000)
    } finally {
      setIsExecuting(false)
      setShowParams(false)
    }
  }

  const handleClick = () => {
    if (hasRequiredParams) {
      setShowParams(true)
    } else {
      runAction()
    }
  }

  const buttonVariant = result?.success
    ? "secondary"
    : result?.success === false
      ? "destructive"
      : tone === "danger"
        ? "destructive"
        : tone === "primary"
          ? "default"
          : "outline"

  return (
    <>
      <Button
        type="button"
        size={size === "prominent" ? "default" : "sm"}
        variant={buttonVariant}
        onClick={handleClick}
        disabled={isExecuting}
        title={action.description}
        className={cn("capitalize", result?.success && "text-success border-success/30")}
      >
        {isExecuting ? <Loader2 className="animate-spin" /> : null}
        {actionId.replace(/-/g, " ")}
      </Button>
      <ActionParamsDialog
        open={showParams}
        onOpenChange={setShowParams}
        action={action}
        actionId={actionId}
        onSubmit={runAction}
      />
    </>
  )
}
