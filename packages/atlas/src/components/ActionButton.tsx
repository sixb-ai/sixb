import type { ActionParam, ObjectAction } from "@sixb/client"
import { decodeObjectId } from "@sixb/client"
import { useActionRunMutation } from "@sixb/client/hooks"
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
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  FileRefUploadField,
  parseFileRefFormValue,
  stringifyFileRefFormValue,
} from "./FileRefUploadField"

type ActionParams = Record<string, unknown>

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
  submitting?: boolean
}

function ActionParamsDialog({
  open,
  onOpenChange,
  action,
  actionId,
  onSubmit,
  submitting = false,
}: ActionParamsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingFileUploads, setPendingFileUploads] = useState<ReadonlySet<string>>(() => new Set())
  const hasPendingFileUploads = pendingFileUploads.size > 0

  useEffect(() => {
    if (!open) {
      setValues({})
      setErrors({})
      setPendingFileUploads(new Set())
    }
  }, [open])

  function setParamValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors(({ [key]: _removed, ...rest }) => rest)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && hasPendingFileUploads) return

    if (!nextOpen) {
      setValues({})
      setErrors({})
      setPendingFileUploads(new Set())
    }
    onOpenChange(nextOpen)
  }

  const handleFileUploadPendingChange = useCallback((paramId: string, pending: boolean) => {
    setPendingFileUploads((current) => {
      const hasParam = current.has(paramId)
      if (hasParam === pending) return current

      const next = new Set(current)
      if (pending) next.add(paramId)
      else next.delete(paramId)
      return next
    })
  }, [])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (hasPendingFileUploads) return
    const params: ActionParams = {}
    const nextErrors: Record<string, string> = {}
    for (const [key, def] of Object.entries(action.params ?? {})) {
      const value = values[key]?.trim() ?? ""
      if (!value) {
        if (def.required) nextErrors[key] = "Required."
        continue
      }

      if (def.type === "number") {
        params[key] = Number(value)
      } else if (def.type === "boolean") {
        params[key] = value === "true"
      } else if (def.type === "fileRef") {
        const fileRef = parseFileRefFormValue(value)
        if (!fileRef) {
          nextErrors[key] = "Expected an uploaded file."
          continue
        }
        params[key] = fileRef
      } else {
        params[key] = value
      }
    }

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit(params)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
                  onValueChange={(value) => setParamValue(key, value)}
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
                  onValueChange={(value) => setParamValue(key, value)}
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
              ) : def.type === "fileRef" ? (
                <FileRefUploadField
                  id={`action-param-${key}`}
                  value={parseFileRefFormValue(values[key])}
                  onChange={(fileRef) =>
                    setParamValue(key, fileRef ? stringifyFileRefFormValue(fileRef) : "")
                  }
                  errorId={errors[key] ? `action-param-${key}-error` : undefined}
                  logicalPathPrefix={`actions/${actionId}/${key}`}
                  disabled={submitting}
                  onPendingChange={(pending) => handleFileUploadPendingChange(key, pending)}
                />
              ) : (
                <Input
                  id={`action-param-${key}`}
                  type={def.type === "number" ? "number" : "text"}
                  value={values[key] ?? ""}
                  onChange={(event) => setParamValue(key, event.target.value)}
                  required={def.required}
                  placeholder={`Enter ${key}...`}
                />
              )}
              {errors[key] ? (
                <p id={`action-param-${key}-error`} className="text-xs text-destructive">
                  {errors[key]}
                </p>
              ) : null}
            </div>
          ))}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting || hasPendingFileUploads}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || hasPendingFileUploads}>
              {submitting || hasPendingFileUploads ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {hasPendingFileUploads ? "Uploading..." : "Run"}
            </Button>
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
  const [showParams, setShowParams] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message?: string } | null>(null)
  const requestAction = useActionRunMutation({
    invalidateOnCommit: true,
    onSuccess: (run) => {
      setResult({ success: true })
      setShowParams(false)
      navigate(`/actions/runs/${run.id}`)
    },
    onError: (error) => {
      setShowParams(false)
      setResult({
        success: false,
        message: error instanceof Error ? error.message : "Action failed",
      })
      setTimeout(() => setResult(null), 3000)
    },
  })

  const params = Object.values(action.params ?? {})
  const hasRequiredParams = params.some((p: ActionParam) => p.required)
  const hasFileParams = params.some((p: ActionParam) => p.type === "fileRef")
  const shouldConfirm = requireConfirm ?? tone === "danger"

  const runAction = (params?: ActionParams) => {
    if (shouldConfirm) {
      const confirmed = window.confirm(`Run "${actionId.replace(/-/g, " ")}" on ${objectId}?`)
      if (!confirmed) return
    }

    requestAction.reset()
    setResult(null)

    const parsed = decodeObjectId(objectId)
    if (!parsed) {
      setResult({
        success: false,
        message: `Invalid object id: ${objectId}`,
      })
      setTimeout(() => setResult(null), 3000)
      return
    }

    requestAction.mutate({
      path: { actionId },
      body: {
        subject: {
          kind: "object",
          objectTypeId: parsed.objectTypeId,
          primaryId: parsed.primaryId,
        },
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      },
    })
  }

  const handleClick = () => {
    if (hasRequiredParams || hasFileParams) {
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
  const isExecuting = requestAction.isPending

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
        submitting={isExecuting}
      />
    </>
  )
}
