import type { ActionParam, ObjectAction } from "@pario/client"
import { executeAction as executeActionRequest } from "@pario/client"
import { useState } from "react"
import { cn } from "../lib/utils"
import { Badge } from "./ui/badge"

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
  action: ObjectAction
  actionId: string
  onSubmit: (params: ActionParams) => void
  onCancel: () => void
}

function ActionParamsDialog({ action, actionId, onSubmit, onCancel }: ActionParamsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({})

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
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

  const inputClass = cn(
    "w-full px-3 py-2 rounded-lg text-sm",
    "bg-background/50 border border-border/50",
    "text-foreground",
    "focus:outline-none focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/50",
    "transition-colors duration-200"
  )

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        className={cn(
          "rounded-2xl border border-border/50 bg-card/90 backdrop-blur-xl shadow-xl",
          "max-w-md w-full mx-4",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
        )}
      >
        <div className="px-5 py-4 border-b border-border/50">
          <h3 className="text-sm font-semibold text-foreground">{actionId.replace(/-/g, " ")}</h3>
          {action.description && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{action.description}</p>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-5 py-4 space-y-3">
            {Object.entries(action.params ?? {}).map(([key, def]: [string, ActionParam]) => (
              <div key={key}>
                <label className="flex items-center gap-1.5 text-xs font-medium text-foreground mb-1.5">
                  {key}
                  {def.required && (
                    <Badge
                      variant="secondary"
                      className="text-[8px] px-1 py-0 h-3.5 bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    >
                      REQUIRED
                    </Badge>
                  )}
                </label>
                {def.description && (
                  <p className="text-[11px] text-muted-foreground mb-1.5">{def.description}</p>
                )}
                {def.enum ? (
                  <select
                    value={values[key] ?? ""}
                    onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                    required={def.required}
                    className={inputClass}
                  >
                    <option value="">Select...</option>
                    {def.enum.map((opt) => (
                      <option key={String(opt)} value={String(opt)}>
                        {String(opt)}
                      </option>
                    ))}
                  </select>
                ) : def.type === "boolean" ? (
                  <select
                    value={values[key] ?? ""}
                    onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                    required={def.required}
                    className={inputClass}
                  >
                    <option value="">Select...</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={def.type === "number" ? "number" : "text"}
                    value={values[key] ?? ""}
                    onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                    required={def.required}
                    className={cn(inputClass, "placeholder:text-muted-foreground/50")}
                    placeholder={`Enter ${key}...`}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-border/50 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors duration-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-500 border border-emerald-500/30 hover:bg-emerald-500/25 hover:border-emerald-500/50 transition-all duration-200"
            >
              Run
            </button>
          </div>
        </form>
      </div>
    </div>
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

      if (response.data?.success) {
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

  return (
    <>
      <button
        onClick={handleClick}
        disabled={isExecuting}
        title={action.description}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 border font-medium transition-colors duration-200",
          size === "prominent"
            ? "min-h-10 rounded-xl px-4 py-2 text-sm"
            : "rounded-lg px-3 py-1.5 text-xs",
          "border",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          result?.success
            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
            : result?.success === false
              ? "bg-red-500/10 text-red-400 border-red-500/30"
              : tone === "danger"
                ? "bg-red-500/10 text-red-300 border-red-500/35 hover:bg-red-500/20 hover:border-red-500/50 hover:text-red-200"
                : tone === "primary"
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/35 hover:bg-emerald-500/20 hover:border-emerald-500/50 hover:text-emerald-200"
                  : "bg-background/50 text-foreground/70 border-border/50 hover:text-foreground hover:border-border hover:bg-accent/40"
        )}
      >
        {isExecuting && (
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {actionId.replace(/-/g, " ")}
      </button>
      {showParams && (
        <ActionParamsDialog
          action={action}
          actionId={actionId}
          onSubmit={runAction}
          onCancel={() => setShowParams(false)}
        />
      )}
    </>
  )
}
