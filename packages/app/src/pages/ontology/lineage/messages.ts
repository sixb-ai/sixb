import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"

/** Where an object's values come from: the source marks on its properties and the trail panel. */
export const en = {
  title: "Where this value comes from",
  propertyOf: (property: string, object: string) => `${property} of ${object}`,
  marks: {
    projection: (projection: string) => `Imported from ${projection}`,
    edit: (when: string) => `Edited ${when}`,
    telemetry: "Set by the latest telemetry point",
  },
  summary: {
    importedFrom: "Imported from",
    createdBy: (action: string) => `Created by ${action}`,
    createdByEdit: "Created by an edit",
    edited: (count: number) =>
      plural("en", count, { one: "1 value edited", other: `${count} values edited` }),
  },
  steps: {
    edit: "Edited",
    projection: "Projection",
    dataset: "Dataset",
    upstream: "Upstream dataset",
    telemetry: "Telemetry",
  },
  edit: {
    direct: "Direct edit",
    generic: "Edit",
    commitUnknown: "Commit unknown",
    agent: "The agent",
    serviceAccount: "Service account",
    member: "Member",
    viewActionRun: "View action run",
    viewWorkflowRun: "View workflow run",
  },
  replaced: {
    label: "Replaced",
    importedFrom: "Imported from",
    editedBy: (name: string, when: string) => `Edited by ${name} ${when}`,
    edited: (when: string) => `Edited ${when}`,
    noValue: "No value",
  },
  resolution: {
    editNewer: (projection: string) => `Newer than the ${projection} value`,
    editNewerThanSource: "Newer than the source value",
    sourceNewer: (name: string) => `The source is newer than ${name}’s edit`,
    sourceNewerThanEdit: "The source is newer than the edit",
  },
  version: (id: string) => `Version ${id}`,
  expired: "No longer stored",
  moreUpstream: "More upstream",
  restricted: (count: number) =>
    plural("en", count, { one: "1 step you can’t see", other: `${count} steps you can’t see` }),
  observed: (when: string) => `Observed ${when}`,
  telemetryFrom: "From",
  appendedDirectly: "Appended directly",
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  title: "D’où vient cette valeur",
  propertyOf: (property: string, object: string) => `${property} de ${object}`,
  marks: {
    projection: (projection: string) => `Importée depuis ${projection}`,
    edit: (when: string) => `Modifiée ${when}`,
    telemetry: "Fixée par le dernier point de télémétrie",
  },
  summary: {
    importedFrom: "Importé depuis",
    createdBy: (action: string) => `Créé par ${action}`,
    createdByEdit: "Créé par une modification",
    edited: (count: number) =>
      plural("fr", count, { one: "1 valeur modifiée", other: `${count} valeurs modifiées` }),
  },
  steps: {
    edit: "Modifiée",
    projection: "Projection",
    dataset: "Jeu de données",
    upstream: "Jeu de données en amont",
    telemetry: "Télémétrie",
  },
  edit: {
    direct: "Modification directe",
    generic: "Modification",
    commitUnknown: "Commit inconnu",
    agent: "L’agent",
    serviceAccount: "Compte de service",
    member: "Membre",
    viewActionRun: "Voir l’exécution de l’action",
    viewWorkflowRun: "Voir l’exécution du workflow",
  },
  replaced: {
    label: "Valeur remplacée",
    importedFrom: "Importée depuis",
    editedBy: (name: string, when: string) => `Modifiée par ${name} ${when}`,
    edited: (when: string) => `Modifiée ${when}`,
    noValue: "Aucune valeur",
  },
  resolution: {
    editNewer: (projection: string) => `Plus récente que la valeur de ${projection}`,
    editNewerThanSource: "Plus récente que la valeur de la source",
    sourceNewer: (name: string) => `La source est plus récente que la modification de ${name}`,
    sourceNewerThanEdit: "La source est plus récente que la modification",
  },
  version: (id: string) => `Version ${id}`,
  expired: "N’est plus conservée",
  moreUpstream: "Plus en amont",
  restricted: (count: number) =>
    plural("fr", count, {
      one: "1 étape que vous ne pouvez pas voir",
      other: `${count} étapes que vous ne pouvez pas voir`,
    }),
  observed: (when: string) => `Observée ${when}`,
  telemetryFrom: "Depuis",
  appendedDirectly: "Ajoutée directement",
}

export const useLineageMessages = defineMessages<typeof en>({ en, fr }).useMessages
