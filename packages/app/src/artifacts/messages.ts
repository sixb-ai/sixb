import { defineMessages, type MessageTree, type Translation } from "@sixb/ui/lib/i18n"

const number = (value: number) => value.toLocaleString("en")
const numberFr = (value: number) => value.toLocaleString("fr")

/** Source catalog of the artifact viewer. */
export const en = {
  kinds: {
    document: "Document",
    sheet: "Sheet",
    slides: "Slides",
    page: "Page",
    file: "File",
  },
  viewer: {
    version: (version: number) => `v${version}`,
    versionLabel: (version: number) => `Version ${number(version)}`,
    versions: "Versions",
    versionItem: (version: number, date: string) => `Version ${number(version)} · ${date}`,
    latest: "Latest",
    copyLink: "Copy link",
    linkCopied: "Link copied",
    download: (name: string) => `Download ${name}`,
    downloadLabel: "Download",
    openFullPage: "Open full page",
    openInNewTab: (name: string) => `Open ${name} in a new tab`,
    close: "Close",
    back: "Back",
    loading: "Loading…",
    notFound: "This artifact is not available",
    notFoundDescription: "It was deleted, or it belongs to someone else.",
    storageUnavailable: "Artifact storage is not available.",
    loadFailed: "This artifact could not be loaded.",
    unsupportedKind: (kind: string) => `Sixb can't show ${kind} artifacts yet.`,
  },
  document: {
    meta: (version: number, date: string) => `Version ${number(version)} · ${date}`,
    outline: "On this page",
    copySection: (heading: string) => `Copy a link to “${heading}”`,
    callouts: {
      note: "Note",
      tip: "Tip",
      important: "Important",
      warning: "Warning",
      caution: "Caution",
    },
  },
  files: {
    file: "File",
    unknownSize: "Unknown size",
    bytes: "B",
    kilobytes: "KB",
    megabytes: "MB",
    gigabytes: "GB",
    terabytes: "TB",
    noPreview: "No preview for this file",
    noPreviewDescription: "Download it to open it in another app.",
    tooLarge: "This file is too large to preview",
    tooLargeDescription: "Download it to see all of it.",
    loading: "Loading file…",
    gone: "This file is no longer available.",
    storageUnavailable: "File storage is not available.",
    loadFailed: "This file could not be loaded.",
    noText: "The file has no readable text.",
    tableFailed: "This table could not be read",
    malformed: "The file has malformed rows.",
    malformedNear: (row: number) => `The file has a malformed row near row ${number(row)}.`,
    emptyFile: "The file is empty.",
    noHeader: "The file has no header row.",
    column: (index: number) => `Column ${number(index)}`,
    showing: (shown: number, total: number) =>
      `Showing the first ${number(shown)} of ${number(total)} rows.`,
    pdfUnavailable: "This browser can't show the PDF here",
    pdfDescription: "Open it in a new tab, or download it.",
  },
} satisfies MessageTree

export type ArtifactMessages = typeof en

export const fr: Translation<ArtifactMessages> = {
  kinds: {
    document: "Document",
    sheet: "Feuille",
    slides: "Diapositives",
    page: "Page",
    file: "Fichier",
  },
  viewer: {
    version: (version) => `v${version}`,
    versionLabel: (version) => `Version ${numberFr(version)}`,
    versions: "Versions",
    versionItem: (version, date) => `Version ${numberFr(version)} · ${date}`,
    latest: "Dernière",
    copyLink: "Copier le lien",
    linkCopied: "Lien copié",
    download: (name) => `Télécharger ${name}`,
    downloadLabel: "Télécharger",
    openFullPage: "Ouvrir en pleine page",
    openInNewTab: (name) => `Ouvrir ${name} dans un nouvel onglet`,
    close: "Fermer",
    back: "Retour",
    loading: "Chargement…",
    notFound: "Cet artefact n’est pas disponible",
    notFoundDescription: "Il a été supprimé, ou il appartient à quelqu’un d’autre.",
    storageUnavailable: "Le stockage des artefacts n’est pas disponible.",
    loadFailed: "Impossible de charger cet artefact.",
    unsupportedKind: (kind) => `Sixb ne sait pas encore afficher les artefacts de type ${kind}.`,
  },
  document: {
    meta: (version, date) => `Version ${numberFr(version)} · ${date}`,
    outline: "Sur cette page",
    copySection: (heading) => `Copier un lien vers « ${heading} »`,
    callouts: {
      note: "Remarque",
      tip: "Conseil",
      important: "Important",
      warning: "Attention",
      caution: "Prudence",
    },
  },
  files: {
    file: "Fichier",
    unknownSize: "Taille inconnue",
    bytes: "o",
    kilobytes: "Ko",
    megabytes: "Mo",
    gigabytes: "Go",
    terabytes: "To",
    noPreview: "Pas d’aperçu pour ce fichier",
    noPreviewDescription: "Téléchargez-le pour l’ouvrir dans une autre application.",
    tooLarge: "Ce fichier est trop volumineux pour l’aperçu",
    tooLargeDescription: "Téléchargez-le pour le voir en entier.",
    loading: "Chargement du fichier…",
    gone: "Ce fichier n’est plus disponible.",
    storageUnavailable: "Le stockage des fichiers n’est pas disponible.",
    loadFailed: "Impossible de charger ce fichier.",
    noText: "Le fichier ne contient pas de texte lisible.",
    tableFailed: "Impossible de lire ce tableau",
    malformed: "Le fichier contient des lignes mal formées.",
    malformedNear: (row) =>
      `Le fichier contient une ligne mal formée vers la ligne ${numberFr(row)}.`,
    emptyFile: "Le fichier est vide.",
    noHeader: "Le fichier ne contient pas de ligne d’en-tête.",
    column: (index) => `Colonne ${numberFr(index)}`,
    showing: (shown, total) =>
      `Seules les ${numberFr(shown)} premières lignes sur ${numberFr(total)} sont affichées.`,
    pdfUnavailable: "Ce navigateur ne peut pas afficher le PDF ici",
    pdfDescription: "Ouvrez-le dans un nouvel onglet, ou téléchargez-le.",
  },
}

const artifactMessages = defineMessages<ArtifactMessages>({ en, fr })

/** Messages of the artifact viewer in the current locale. */
export const useArtifactMessages = artifactMessages.useMessages
