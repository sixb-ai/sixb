import { cn } from "../../lib/utils"

interface GlassCardProps {
  children: React.ReactNode
  className?: string
  padding?: "none" | "sm" | "md" | "lg"
}

const paddingClasses = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
}

export function GlassCard({ children, className, padding = "md" }: GlassCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl shadow-lg",
        paddingClasses[padding],
        className
      )}
    >
      {children}
    </div>
  )
}
