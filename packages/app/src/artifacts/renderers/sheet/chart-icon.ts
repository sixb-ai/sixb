import type { SheetChartType } from "@sixb/core/artifacts"
import {
  AreaChart,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  type LucideIcon,
} from "lucide-react"

/** Each kind of chart's icon, wherever a chart is named: its tab, a card. */
export const CHART_ICONS: Readonly<Record<SheetChartType, LucideIcon>> = {
  bar: ChartColumn,
  line: ChartLine,
  area: AreaChart,
  pie: ChartPie,
  scatter: ChartScatter,
}
