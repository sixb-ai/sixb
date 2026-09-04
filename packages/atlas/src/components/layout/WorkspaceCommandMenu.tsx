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
  Layers,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  ScrollText,
  Settings,
  Workflow,
} from "lucide-react"
import { useEffect } from "react"
import { useNavigate } from "react-router-dom"

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
    commands: [
      { label: "Connectors", path: "/connectors", Icon: Cable },
      { label: "Datasets", path: "/datasets", Icon: Database },
      { label: "Syncs", path: "/syncs", Icon: RefreshCw },
      { label: "Pipelines", path: "/pipelines", Icon: Workflow },
      { label: "Projections", path: "/projections", Icon: Layers },
    ],
  },
  {
    label: "Operate",
    commands: [
      { label: "AI usage", path: "/ai-usage", Icon: ChartNoAxesCombined },
      { label: "Logs", path: "/logs", Icon: ScrollText },
      { label: "Rules", path: "/rules", Icon: ListChecks },
      { label: "Settings", path: "/settings/members", Icon: Settings },
    ],
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

  const selectPath = (path: string) => {
    onOpenChange(false)
    navigate(path)
  }

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
        {commandGroups.map((group, groupIndex) => (
          <div key={group.label}>
            {groupIndex > 0 ? <CommandSeparator className="my-1" /> : null}
            <CommandGroup heading={group.label}>
              {group.commands.map((command) => (
                <CommandItem
                  key={command.path}
                  value={`${command.label} ${"description" in command ? command.description : ""}`}
                  onSelect={() => selectPath(command.path)}
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
