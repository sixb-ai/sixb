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
export {
  AgentContextProvider,
  useAgentContext,
  useRegisteredAgentContext,
} from "./agent/agent-context-provider"
export { AgentPanel, type AgentPanelProps } from "./agent/agent-panel"
export { AgentSurface, type AgentSurfaceMode, type AgentSurfaceProps } from "./agent/agent-surface"
export { setAgentSurfaceMode } from "./agent/agent-surface-state"
export { ArtifactPanelRoot, type ArtifactPanelRootProps } from "./agent/artifact-panel"
export {
  AgentThreadSwitcher,
  type AgentThreadSwitcherProps,
} from "./agent/components/agent-thread-switcher"
export { Composer, type ComposerProps } from "./agent/components/composer"
export { ContextChips, type ContextChipsProps } from "./agent/components/context-chips"
export {
  ContextPicker,
  type ContextPickerProps,
  type ContextPickerResult,
} from "./agent/components/context-picker"
export { ModelControls, type ModelControlsProps } from "./agent/components/model-controls"
export { ProviderLogo, type ProviderLogoProps } from "./agent/components/provider-logo"
export {
  ReasoningEffortSlider,
  type ReasoningEffortSliderProps,
} from "./agent/components/reasoning-effort-slider"
export { SandboxRecovery, type SandboxRecoveryProps } from "./agent/components/sandbox-recovery"
export { ThreadArtifactsMenu } from "./agent/components/thread-artifacts-menu"
export { Transcript, type TranscriptProps } from "./agent/components/transcript"
export {
  type AgentConversation,
  type ConversationComposerProps,
  type UseAgentConversationInput,
  useAgentConversation,
} from "./agent/hooks/use-agent-conversation"
export type { LiveRunState } from "./agent/live-run"
export { AgentChatPage, type AgentChatPageProps } from "./agent/react-router"
export type {
  AgentFileRef,
  AgentMessage,
  AgentRun,
  AgentThread,
  LanguageModel,
} from "./agent/types"
export type { ArtifactTarget } from "./artifacts/target"
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
