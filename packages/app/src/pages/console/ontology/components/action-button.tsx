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
import { defineMessages, type MessageTree, type Translation } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useSectionOpen } from "../../../../sections/sections"
import { actionRunHref } from "../../../routes"
import { notify } from "../../../section-page"
import {
  type ActionParamFormValue,
  type ActionParamFormValues,
  actionNeedsParamDialog,
  buildObjectActionParams,
} from "../lib/action-params"
import { ActionParamNullControl } from "./action-param-null-control"
import {
  FileRefUploadField,
  parseFileRefFormValue,
  stringifyFileRefFormValue,
} from "./file-ref-upload-field"
import { UserPicker } from "./user-picker"

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
  const [values, setValues] = useState<ActionParamFormValues>({})
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

  function setParamValue(key: string, value: ActionParamFormValue) {
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

    const result = buildObjectActionParams(action, values)
    setErrors(result.errors)
    if (Object.keys(result.errors).length > 0) return
    onSubmit(result.params)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="capitalize">{actionId.replace(/-/g, " ")}</DialogTitle>
          {action.description ? <DialogDescription>{action.description}</DialogDescription> : null}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {Object.entries(action.params ?? {}).map(([key, def]: [string, ActionParam]) => {
            const formValue = values[key]
            const isNull = formValue === null
            const value = typeof formValue === "string" ? formValue : ""
            const fieldDisabled = submitting || isNull
            const fieldRequired = Boolean(def.required && !isNull)

            return (
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
                  {def.nullable ? (
                    <ActionParamNullControl
                      paramName={key}
                      isNull={isNull}
                      disabled={submitting || pendingFileUploads.has(key)}
                      onNullChange={(nextIsNull) => setParamValue(key, nextIsNull ? null : "")}
                    />
                  ) : null}
                </div>
                {def.description ? (
                  <p className="text-[11px] text-muted-foreground">{def.description}</p>
                ) : null}
                {def.enum ? (
                  <Select
                    value={value}
                    onValueChange={(nextValue) => setParamValue(key, nextValue)}
                    required={fieldRequired}
                    disabled={fieldDisabled}
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
                    value={value}
                    onValueChange={(nextValue) => setParamValue(key, nextValue)}
                    required={fieldRequired}
                    disabled={fieldDisabled}
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
                    key={`${key}:${isNull ? "null" : "value"}`}
                    id={`action-param-${key}`}
                    value={parseFileRefFormValue(value)}
                    onChange={(fileRef) =>
                      setParamValue(key, fileRef ? stringifyFileRefFormValue(fileRef) : "")
                    }
                    errorId={errors[key] ? `action-param-${key}-error` : undefined}
                    logicalPathPrefix={`actions/${actionId}/${key}`}
                    disabled={fieldDisabled}
                    onPendingChange={(pending) => handleFileUploadPendingChange(key, pending)}
                  />
                ) : def.type === "userRef" ? (
                  <UserPicker
                    id={`action-param-${key}`}
                    value={value}
                    onChange={(userId) => setParamValue(key, userId)}
                    required={fieldRequired}
                    disabled={fieldDisabled}
                    aria-describedby={errors[key] ? `action-param-${key}-error` : undefined}
                  />
                ) : (
                  <Input
                    id={`action-param-${key}`}
                    type={def.type === "number" ? "number" : "text"}
                    value={value}
                    onChange={(event) => setParamValue(key, event.target.value)}
                    required={fieldRequired}
                    disabled={fieldDisabled}
                    placeholder={`Enter ${key}...`}
                  />
                )}
                {errors[key] ? (
                  <p id={`action-param-${key}-error`} className="text-xs text-destructive">
                    {errors[key]}
                  </p>
                ) : null}
              </div>
            )
          })}

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

export const en = {
  failed: "The action could not run.",
  invalidObject: (objectId: string) => `This object's id is invalid: ${objectId}`,
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  failed: "L’action n’a pas pu s’exécuter.",
  invalidObject: (objectId: string) => `L’identifiant de cet objet est invalide : ${objectId}`,
}

const useActionButtonMessages = defineMessages<typeof en>({ en, fr }).useMessages

export function ActionButton({
  objectId,
  actionId,
  action,
  tone = "default",
  size = "compact",
  requireConfirm,
}: ActionButtonProps) {
  const navigate = useNavigate()
  const runsOpen = useSectionOpen("console")
  const [showParams, setShowParams] = useState(false)
  const messages = useActionButtonMessages()
  const [result, setResult] = useState<{ success: boolean } | null>(null)
  const resultTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(resultTimer.current), [])

  // The button shows how the request ended for a few seconds.
  const flashResult = (next: { success: boolean }) => {
    setResult(next)
    clearTimeout(resultTimer.current)
    resultTimer.current = setTimeout(() => setResult(null), 3000)
  }

  const showFailure = (message: string) => {
    notify.error(message)
    flashResult({ success: false })
  }

  const requestAction = useActionRunMutation({
    invalidateOnCommit: true,
    onSuccess: (run) => {
      setShowParams(false)
      // The run's page is in the Console; without it, the button shows the outcome.
      if (runsOpen) {
        setResult({ success: true })
        navigate(actionRunHref(run.id))
      } else {
        flashResult({ success: true })
      }
    },
    onError: (error) => {
      setShowParams(false)
      // Shown as is: a rejection's message is the action author's, written for the requester, and
      // any other failed run or refused request carries its own.
      showFailure(error instanceof Error && error.message ? error.message : messages.failed)
    },
  })

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
      showFailure(messages.invalidObject(objectId))
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
    if (actionNeedsParamDialog(action)) {
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
