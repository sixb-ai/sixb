import type { ProjectInfo } from "@pario/client"

interface ProjectSwitcherProps {
  selectedProject: ProjectInfo | null
  connected: boolean
}

export function ProjectSwitcher({ selectedProject, connected }: ProjectSwitcherProps) {
  return (
    <div className="p-4 border-b border-border/50">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        {selectedProject ? (
          <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-accent text-accent-foreground font-semibold shrink-0">
            {selectedProject.name[0].toUpperCase()}
          </div>
        ) : (
          <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-accent shrink-0">
            <svg
              className="w-5 h-5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
        )}

        {/* Name + type */}
        <div className="flex-1 min-w-0">
          {selectedProject ? (
            <>
              <h1 className="text-sm font-semibold text-foreground truncate">
                {selectedProject.name}
              </h1>
              <p className="text-xs text-muted-foreground truncate">{selectedProject.type}</p>
            </>
          ) : (
            <h1 className="text-sm font-medium text-muted-foreground">Loading project...</h1>
          )}
        </div>
      </div>

      {/* Connection status */}
      {selectedProject && (
        <div className="mt-3 flex items-center gap-2">
          <span
            className={`relative flex h-2 w-2 ${connected ? "text-emerald-500" : "text-red-500"}`}
          >
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                connected ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                connected ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
          </span>
          <span className="text-xs text-muted-foreground">
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      )}
    </div>
  )
}
