import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@sixb/ui/components"
import {
  Bolt,
  Bot,
  Box,
  Cable,
  ChartNoAxesCombined,
  Database,
  GitBranch,
  History,
  Layers,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  ScrollText,
  Workflow,
} from "lucide-react"
import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { projectAppUrl } from "../../lib/app-url"

const commandGroups = [
  {
    label: "Explore",
    commands: [
      { label: "Objects", description: "Browse the operational graph", path: "/", Icon: Box },
      {
        label: "Ontology",
        description: "Inspect types and relationships",
        path: "/ontology",
        Icon: LayoutGrid,
      },
    ],
  },
  {
    label: "Automate",
    commands: [
      { label: "Actions", description: "Request typed operations", path: "/actions", Icon: Bolt },
      {
        label: "Workflows",
        description: "Run and supervise processes",
        path: "/workflows",
        Icon: GitBranch,
      },
      { label: "Agents", description: "Inspect registered agents", path: "/agents", Icon: Bot },
    ],
  },
  {
    label: "Data",
    // These pages moved into the project's app; `path` is theirs there.
    inApp: true,
    commands: [
      { label: "Connectors", path: "/data/connectors", Icon: Cable },
      { label: "Datasets", path: "/data/datasets", Icon: Database },
      { label: "Syncs", path: "/data/syncs", Icon: RefreshCw },
      { label: "Pipelines", path: "/data/pipelines", Icon: Workflow },
      { label: "Projections", path: "/data/projections", Icon: Layers },
    ],
  },
  {
    label: "Observability",
    inApp: true,
    commands: [
      { label: "Runs", path: "/observability/runs", Icon: History },
      { label: "Logs", path: "/observability/logs", Icon: ScrollText },
      { label: "AI usage", path: "/observability/ai-usage", Icon: ChartNoAxesCombined },
    ],
  },
  {
    label: "Operate",
    commands: [{ label: "Rules", path: "/rules", Icon: ListChecks }],
  },
] as const

export function WorkspaceCommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        onOpenChange(!open)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onOpenChange, open])

  const selectPath = (path: string, inApp: boolean) => {
    onOpenChange(false)
    const appUrl = inApp ? projectAppUrl(path) : null
    if (appUrl) window.location.assign(appUrl)
    else navigate(path)
  }
  const groups = commandGroups.filter((group) => !("inApp" in group) || projectAppUrl("/"))

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search Atlas"
      description="Navigate to an Atlas workspace"
      className="max-w-xl rounded-xl"
    >
      <CommandInput placeholder="Search…" />
      <CommandList className="max-h-[min(28rem,70vh)] p-1">
        <CommandEmpty>No matching workspace.</CommandEmpty>
        {groups.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 ? <CommandSeparator className="my-1" /> : null}
            <CommandGroup heading={group.label}>
              {group.commands.map((command) => (
                <CommandItem
                  key={command.path}
                  value={`${command.label} ${"description" in command ? command.description : ""}`}
                  onSelect={() => selectPath(command.path, "inApp" in group)}
                  className="min-h-11 rounded-lg px-3"
                >
                  <command.Icon className="size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{command.label}</p>
                    {"description" in command ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {command.description}
                      </p>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
