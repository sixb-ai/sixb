import { logs } from "@sixb/client/logs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sixb/ui/components"
import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { PageFrame } from "../components/common"
import { LogConsole } from "../features/logging/LogConsole"

const KIND_FILTERS = ["all", "sync", "pipeline", "workflow", "action"] as const
type KindFilter = (typeof KIND_FILTERS)[number]

const LEVEL_FILTERS = ["all", "debug", "info", "warn", "error"] as const
type LevelFilter = (typeof LEVEL_FILTERS)[number]

const kindLabels: Record<KindFilter, string> = {
  all: "All kinds",
  sync: "Syncs",
  pipeline: "Pipelines",
  workflow: "Workflows",
  action: "Actions",
}

const levelLabels: Record<LevelFilter, string> = {
  all: "All levels",
  debug: "Debug and up",
  info: "Info and up",
  warn: "Warnings and up",
  error: "Errors only",
}

function isKindFilter(value: string | null): value is KindFilter {
  return value !== null && (KIND_FILTERS as readonly string[]).includes(value)
}

function isLevelFilter(value: string | null): value is LevelFilter {
  return value !== null && (LEVEL_FILTERS as readonly string[]).includes(value)
}

export function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const kindParam = searchParams.get("kind")
  const levelParam = searchParams.get("level")
  const kind: KindFilter = isKindFilter(kindParam) ? kindParam : "all"
  const level: LevelFilter = isLevelFilter(levelParam) ? levelParam : "all"

  const setParam = (key: "kind" | "level", value: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (value === "all") {
          params.delete(key)
        } else {
          params.set(key, value)
        }
        return params
      },
      { replace: true }
    )
  }

  // Identity churns each render, but `useSixbLogs` keys on the serialized filter,
  // so the socket only rebuilds when `kind`/`level` actually change.
  const builder = useMemo(() => {
    const base = kindBuilder(kind)
    // The `=== "all"` check narrows `level` to the concrete `LogLevel` union.
    return level === "all" ? base : base.level(level)
  }, [kind, level])

  return (
    <PageFrame
      title="Logs"
      description="Live run output across syncs, pipelines, workflows, and actions."
      contentClassName="max-w-6xl"
    >
      <LogConsole
        builder={builder}
        showKind
        showRun
        filters={
          <>
            <Select value={kind} onValueChange={(next) => setParam("kind", next)}>
              <SelectTrigger
                size="sm"
                className="min-w-[8.5rem] flex-1 sm:flex-none"
                aria-label="Filter logs by kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {kindLabels[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={level} onValueChange={(next) => setParam("level", next)}>
              <SelectTrigger
                size="sm"
                className="min-w-[8.5rem] flex-1 sm:flex-none"
                aria-label="Filter logs by severity"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {levelLabels[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        className="h-[calc(100dvh-13rem)] min-h-[28rem] md:h-[calc(100dvh-8rem)]"
        emptyLabel="No logs match these filters yet."
      />
    </PageFrame>
  )
}

function kindBuilder(kind: KindFilter) {
  switch (kind) {
    case "sync":
      return logs.syncs()
    case "pipeline":
      return logs.pipelines()
    case "workflow":
      return logs.workflows()
    case "action":
      return logs.actions()
    default:
      return logs.all()
  }
}
