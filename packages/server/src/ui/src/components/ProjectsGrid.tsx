import { Link } from "react-router-dom"

interface ProjectsGridProps {
  projects: Array<{ name: string; type: string }>
}

export function ProjectsGrid({ projects }: ProjectsGridProps) {
  return (
    <div className="mx-auto w-full max-w-7xl p-3 sm:p-4 lg:p-6">
      <h1 className="mb-4 text-xl font-bold text-foreground sm:mb-6 sm:text-2xl">Projects</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <Link
            key={project.name}
            to={`/${project.name}`}
            className="rounded-xl border border-border/50 bg-card/80 p-4 text-left shadow-lg backdrop-blur-xl transition-all hover:border-border hover:bg-card"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-foreground">
                <span className="text-sm font-semibold">{project.name[0].toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-foreground">{project.name}</h3>
                <p className="text-xs text-muted-foreground">{project.type}</p>
              </div>
              <svg
                className="h-5 w-5 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
