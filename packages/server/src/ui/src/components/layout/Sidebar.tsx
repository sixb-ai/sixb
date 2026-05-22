import type { ObjectSummary, ProjectInfo } from "@pario/client"
import { cn } from "../../lib/utils"
import { ThemeSwitcher } from "../common"
import { ObjectIcon } from "../ObjectIcon"
import { ScrollArea } from "../ui/scroll-area"
import { Separator } from "../ui/separator"
import { ProjectSwitcher } from "./ProjectSwitcher"
import { SidebarNav, type ViewMode } from "./SidebarNav"

interface SidebarProps {
  selectedProject: ProjectInfo | null
  connected: boolean
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  objects: ObjectSummary[]
  selectedObjectId: string | null
  onSelectObject: (id: string) => void
  datasetCount?: number
  connectorCount?: number
  syncCount?: number
  pipelineCount?: number
  ruleCount?: number
  ontologyCount?: number
  showObjectList?: boolean
  className?: string
}

export function Sidebar({
  selectedProject,
  connected,
  viewMode,
  onViewChange,
  objects,
  selectedObjectId,
  onSelectObject,
  datasetCount,
  connectorCount,
  syncCount,
  pipelineCount,
  ruleCount,
  ontologyCount,
  showObjectList = true,
  className,
}: SidebarProps) {
  const hasSelectedProject = !!selectedProject

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 w-full flex-col border-r border-border/50 bg-card/70 backdrop-blur-xl",
        className
      )}
    >
      <ProjectSwitcher selectedProject={selectedProject} connected={connected} />

      <SidebarNav
        viewMode={viewMode}
        onViewChange={onViewChange}
        objectCount={objects.length}
        datasetCount={datasetCount}
        connectorCount={connectorCount}
        syncCount={syncCount}
        pipelineCount={pipelineCount}
        ruleCount={ruleCount}
        ontologyCount={ontologyCount}
      />

      <Separator className="opacity-50" />

      {/* Object list - only show when in home view and we have objects */}
      {hasSelectedProject && showObjectList && viewMode === "home" && objects.length > 0 && (
        <ScrollArea className="flex-1">
          <div className="p-2">
            <h3 className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Objects
            </h3>
            <ul className="space-y-0.5">
              {objects.map((object) => (
                <li key={object.id}>
                  <button
                    onClick={() => onSelectObject(object.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedObjectId === object.id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    }`}
                  >
                    <ObjectIcon type={object.class} className="w-4 h-4 opacity-70" />
                    <span className="flex-1 text-left truncate">{object.name || object.id}</span>
                    {object.telemetryCount > 0 && (
                      <span className="text-xs opacity-60">{object.telemetryCount}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </ScrollArea>
      )}

      {/* Footer with theme switcher and API docs link */}
      <div className="mt-auto p-4 border-t border-border/50 space-y-3">
        <div className="flex items-center justify-between">
          <ThemeSwitcher />
          <a
            href={`http://${window.location.hostname}:3000/docs`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
            API
          </a>
        </div>
      </div>
    </aside>
  )
}
