/**
 * The sections Sixb builds into every app, as plain data: the build reads it to add their routes,
 * and the browser reads it to draw their navigation. No React here, so the CLI can import it.
 *
 * A section is a group of pages at one path prefix. Its visibility key, set in the project's
 * `visibility` export, decides who sees its pages; pages marked `always` stay open to every
 * signed-in person, because they are about that person rather than the project.
 */

export type AppSectionId = "settings"

export interface SectionPageDefinition {
  readonly id: string
  readonly path: string
  /** The page's export from `@sixb/app/pages`. */
  readonly exportName: string
  readonly group: string
  readonly always?: boolean
}

export interface SectionDefinition {
  readonly id: AppSectionId
  readonly path: string
  /** The export that answers the section's own path by opening its first page. */
  readonly indexExportName: string
  /** Every page needs a signed-in person, so the section is absent when auth is off. */
  readonly requiresUser: boolean
  readonly pages: readonly SectionPageDefinition[]
}

export const sectionCatalog: readonly SectionDefinition[] = [
  {
    id: "settings",
    path: "/settings",
    indexExportName: "SettingsIndexPage",
    requiresUser: true,
    // Pages appear in this order, grouped by their first appearance.
    pages: [
      {
        id: "personal",
        path: "/settings/personal",
        exportName: "SettingsPersonalPage",
        group: "account",
        always: true,
      },
      {
        id: "developers",
        path: "/settings/developers",
        exportName: "SettingsDevelopersPage",
        group: "account",
        always: true,
      },
      {
        id: "members",
        path: "/settings/members",
        exportName: "SettingsMembersPage",
        group: "project",
      },
      {
        id: "service-accounts",
        path: "/settings/service-accounts",
        exportName: "SettingsServiceAccountsPage",
        group: "project",
      },
    ],
  },
]

export const sectionIds: readonly AppSectionId[] = sectionCatalog.map((section) => section.id)
