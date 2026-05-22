import { cn } from "../lib/utils"

interface UsageBarProps {
  value: number
  max?: number
  color?: "blue" | "green" | "amber" | "red" | "auto"
  showLabel?: boolean
  size?: "sm" | "md"
}

function getAutoColor(percentage: number): string {
  if (percentage < 50) return "bg-emerald-500"
  if (percentage < 75) return "bg-amber-500"
  return "bg-red-500"
}

const colorMap = {
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
}

export function UsageBar({
  value,
  max = 100,
  color = "auto",
  showLabel = false,
  size = "sm",
}: UsageBarProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100))
  const barColor = color === "auto" ? getAutoColor(percentage) : colorMap[color]
  const heightClass = size === "sm" ? "h-1.5" : "h-2.5"

  return (
    <div className="w-full">
      <div className={cn("w-full rounded-full overflow-hidden bg-accent/50", heightClass)}>
        <div
          className={cn(
            "rounded-full transition-all duration-500 shadow-[inset_0_-1px_0_rgba(255,255,255,0.2)]",
            heightClass,
            barColor
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <p className="text-xs text-muted-foreground mt-1 text-right">{percentage.toFixed(0)}%</p>
      )}
    </div>
  )
}
