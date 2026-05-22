interface MobileProjectSwitcherProps {
  currentProjectName: string | null
}

export function MobileProjectSwitcher({ currentProjectName }: MobileProjectSwitcherProps) {
  const displayName = currentProjectName ?? "Pario"

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-[11px] font-semibold text-accent-foreground">
        {displayName[0]?.toUpperCase() ?? "P"}
      </div>
      <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
    </div>
  )
}
