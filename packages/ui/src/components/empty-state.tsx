import type * as React from "react"
import { cn } from "../lib/utils"

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center p-8 text-center", className)}>
      {icon ? <div className="mb-4 text-muted-foreground/50">{icon}</div> : null}
      <h3 className="mb-1 text-sm font-medium text-foreground">{title}</h3>
      {description ? <p className="mb-4 text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  )
}
