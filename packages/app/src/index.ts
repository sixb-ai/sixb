/**
 * Everything `@sixb/app` offers code in a project's `app/` directory.
 *
 * One module for both places that code runs: the browser bundle, and Bun when the build imports
 * `app/layout.tsx` to read its exports. Nothing here may need Node or Bun, and nothing may touch
 * `window` or `document` at module scope. The CLI's tooling lives in `@sixb/app/server`.
 *
 * Components and data stay where they live: `@sixb/ui` for the design system and `@sixb/client`
 * for the API. This entry never re-exports them, so each name has one import path.
 */

export { agentContext } from "@sixb/core/agents/context"
export type { ModelReasoningLevel } from "@sixb/core/models"
export { AgentContextProvider, useAgentContext } from "./agent/agent-context-provider"
export { AgentPanel, type AgentPanelProps } from "./agent/agent-panel"
export { AgentSurface, type AgentSurfaceMode, type AgentSurfaceProps } from "./agent/agent-surface"
export { setAgentSurfaceMode } from "./agent/agent-surface-state"
export { Composer, type ComposerProps } from "./agent/components/composer"
export type {
  AgentDocumentPreviewRenderer,
  AgentDocumentPreviewRendererProps,
} from "./agent/document-preview/types"
export { AgentChatPage, type AgentChatPageProps } from "./agent/react-router"
export type { LanguageModel } from "./agent/types"
export { AgentWorkspaceProvider, type AgentWorkspaceProviderProps } from "./agent/workspace"
export type { AuthExperienceActions, AuthExperienceProps, AuthExperienceState } from "./auth"
export type { AppMetadata } from "./metadata"
export { SyncButton, type SyncButtonProps } from "./pages/data/sync-button"
export { publicEnv } from "./public-env"
export type { AppSectionId } from "./sections/catalog"
export {
  type AppSection,
  type AppVisibility,
  useCurrentSection,
  useSections,
} from "./sections/sections"
export { type CurrentUser, useCurrentUser, useSignOut } from "./session"
export { AgentDock } from "./shell/agent-dock"
export {
  AppShell,
  type AppShellProps,
  AppShellProvider,
  type AppShellProviderProps,
} from "./shell/app-shell"
export { Brand, type BrandProps } from "./shell/brand"
export {
  type NavEntry,
  type NavGroup,
  type NavItem,
  NavItems,
  type NavItemsProps,
} from "./shell/nav-items"
export { SearchCommand, type SearchCommandProps } from "./shell/search-command"
export { SectionNav, type SectionNavProps } from "./shell/section-nav"
export { UserMenu, type UserMenuItemProps, type UserMenuProps } from "./shell/user-menu"
