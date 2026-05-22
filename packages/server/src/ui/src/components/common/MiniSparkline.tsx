import { useMemo } from "react"
import { cn } from "../../lib/utils"

interface MiniSparklineProps {
  data: { value: number; timestamp: string }[]
  width?: number
  height?: number
  color?: string
  showDot?: boolean
  className?: string
}

export function MiniSparkline({
  data,
  width = 60,
  height = 24,
  color = "#10b981",
  showDot = true,
  className,
}: MiniSparklineProps) {
  const pathData = useMemo(() => {
    if (!data || data.length < 2) return null

    const values = data.map((d) => d.value)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1

    const padding = 2
    const chartWidth = width - padding * 2
    const chartHeight = height - padding * 2

    const points = data.map((d, i) => {
      const x = padding + (i / (data.length - 1)) * chartWidth
      const y = padding + chartHeight - ((d.value - min) / range) * chartHeight
      return { x, y }
    })

    const path = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ")

    return { path, lastPoint: points[points.length - 1] }
  }, [data, width, height])

  if (!pathData) {
    return (
      <div
        className={cn("flex items-center justify-center text-muted-foreground/50", className)}
        style={{ width, height }}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01"
          />
        </svg>
      </div>
    )
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
    >
      {/* Gradient fill under the line */}
      <defs>
        <linearGradient id={`sparkline-gradient-${color}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Area fill */}
      <path
        d={`${pathData.path} L ${width - 2} ${height - 2} L 2 ${height - 2} Z`}
        fill={`url(#sparkline-gradient-${color})`}
        className="animate-in fade-in duration-500"
      />

      {/* Line */}
      <path
        d={pathData.path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-in fade-in duration-300"
      />

      {/* Current value dot */}
      {showDot && pathData.lastPoint && (
        <g>
          {/* Glow effect */}
          <circle
            cx={pathData.lastPoint.x}
            cy={pathData.lastPoint.y}
            r={4}
            fill={color}
            opacity={0.3}
            className="animate-pulse"
          />
          {/* Dot */}
          <circle cx={pathData.lastPoint.x} cy={pathData.lastPoint.y} r={2} fill={color} />
        </g>
      )}
    </svg>
  )
}
