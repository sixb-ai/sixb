import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"

/** Source catalog of Console › Branches. */
export const en = {
  title: "Branches",
  description:
    "Try a git branch on a copy of production's data before you merge it. Production stays untouched.",
  newBranch: "New branch",
  loadFailed: "Branches couldn't be loaded",
  tryAgain: "Try again",
  denied:
    "Branches take the right to manage the project's code. Ask an admin if you should have it.",
  empty: {
    title: "No branches yet",
    description:
      "Open a git branch to run its code on a copy of what you see in production. Nothing it does reaches production.",
  },
  setup: {
    title: "Branches aren't set up yet",
    storage: "Branches run next to production's database. Use @sixb/pg for production's storage.",
    source: "Branches run your project's code from its repository. Name it in sixb.config.ts:",
    sandboxes:
      "Each branch runs in a sandbox of its own. Add a sandbox provider in sixb.config.ts, such as @sixb/sandboxes-vercel.",
    "sandbox-shares-host":
      "The local sandbox would run branches on production's own machine. Use @sixb/sandboxes-vercel or @sixb/sandboxes-smolvm.",
    "sandbox-env":
      "The sandbox recipe sets environment variables, which every branch would get. Remove its env: branches run with your project's dev values.",
  },
  status: {
    ready: "Ready",
    starting: "Starting",
    refreshing: "Refreshing",
    stopping: "Stopping",
    stopped: "Stopped",
    attention: "Needs attention",
    deleting: "Deleting",
  },
  steps: {
    label: "Progress",
    preparing: "Preparing machine",
    copying: "Copying data",
    starting: "Starting",
    done: "Done",
    current: "In progress",
    waiting: "Not started",
  },
  waitingForWorker:
    "No branch worker has picked it up yet. Production runs branches with sixb worker branches.",
  dataFrom: (age: string) => `Production data from ${age}`,
  dataJustNow: "Production data from just now",
  noData: "No data copied yet",
  openedBy: (name: string) => `Opened by ${name}`,
  openedByYou: "Opened by you",
  lastUsed: (age: string) => `Used ${age}`,
  actions: {
    open: "Open",
    start: "Start",
    retry: "Try again",
    more: (name: string) => `More for ${name}`,
    refresh: "Refresh from production…",
    stop: "Stop",
    delete: "Delete…",
    copyError: "Copy error",
  },
  opening: "Signing you in…",
  openFailed: "The branch could not be opened.",
  popupBlocked: "Your browser blocked the new tab. Allow pop-ups for this site and try again.",
  started: (name: string) => `Starting ${name}`,
  stopped: (name: string) => `${name} stopped`,
  refreshed: (name: string) => `Refreshing ${name} from production`,
  deleted: (name: string) => `Deleting ${name}`,
  actionFailed: "That didn't work. Try again in a moment.",
  attention: {
    code: "The branch's code didn't start.",
    codeHint: (file: string) => `Fix ${file} and push: the branch reloads by itself.`,
    codeHintNoFile: "Fix the error and push: the branch reloads by itself.",
    machine: "The branch couldn't start.",
    details: "Details",
    file: "File",
  },
  notices: {
    "data-reset":
      "Its machine was replaced, so it took a new copy of production. Changes made on the branch are gone.",
    "no-dev-env": "It runs without your project's dev values: production couldn't read them.",
    "machine-ended": "Its machine reached the provider's time limit and stopped.",
    "temp-files-uncapped":
      "A heavy query on this branch could fill production's database disk. Ask whoever runs production's database to let Sixb cap it (SET on temp_file_limit).",
  },
  notCopied: {
    summary: (types: number, datasets: number) => {
      const parts = [
        ...(types > 0 ? [plural("en", types, { one: "1 type", other: `${types} types` })] : []),
        ...(datasets > 0
          ? [plural("en", datasets, { one: "1 dataset", other: `${datasets} datasets` })]
          : []),
      ]
      const verb = types + datasets === 1 ? "wasn't" : "weren't"
      return `${parts.join(" and ")} ${verb} copied`
    },
    unreadable: (name: string) => `${name} can't read it in production.`,
    changed: "Its definition changed on this branch, so production's rows no longer fit.",
    hiddenColumns: (name: string, columns: string) =>
      `${name} can't read every column (${columns}), so none of it was copied.`,
    someone: "The person who opened it",
  },
  refresh: {
    title: (name: string) => `Refresh ${name} from production?`,
    description:
      "It takes a new copy of what you see in production now. Changes made on this branch are discarded.",
    confirm: "Refresh",
  },
  remove: {
    title: (name: string) => `Delete ${name}?`,
    description:
      "Its machine and its copy of production's data are deleted. Your git branch and your code stay as they are.",
    confirm: "Delete",
  },
  create: {
    title: "Open a branch",
    description:
      "Production runs the branch's code on a copy of what you see now. Push the branch first.",
    label: "Git branch",
    placeholder: "feature/invoices",
    submit: "Open branch",
    invalid: "Enter the name of a git branch, such as feature/invoices.",
  },
  cancel: "Cancel",
} satisfies MessageTree

export type BranchesMessages = typeof en

export const fr: Translation<BranchesMessages> = {
  title: "Branches",
  description:
    "Essayez une branche git sur une copie des données de production avant de la fusionner. La production n’est pas touchée.",
  newBranch: "Nouvelle branche",
  loadFailed: "Les branches n’ont pas pu être chargées",
  tryAgain: "Réessayer",
  denied:
    "Les branches demandent le droit de gérer le code du projet. Demandez à un administrateur si vous devriez l’avoir.",
  empty: {
    title: "Aucune branche pour l’instant",
    description:
      "Ouvrez une branche git pour exécuter son code sur une copie de ce que vous voyez en production. Rien de ce qu’elle fait n’atteint la production.",
  },
  setup: {
    title: "Les branches ne sont pas encore configurées",
    storage:
      "Les branches tournent à côté de la base de données de production. Utilisez @sixb/pg pour le stockage de production.",
    source:
      "Les branches exécutent le code de votre projet depuis son dépôt. Indiquez-le dans sixb.config.ts :",
    sandboxes:
      "Chaque branche tourne dans son propre bac à sable. Ajoutez un fournisseur dans sixb.config.ts, par exemple @sixb/sandboxes-vercel.",
    "sandbox-shares-host":
      "Le bac à sable local exécuterait les branches sur la machine de production. Utilisez @sixb/sandboxes-vercel ou @sixb/sandboxes-smolvm.",
    "sandbox-env":
      "La recette du bac à sable définit des variables d’environnement, que chaque branche recevrait. Retirez son env : les branches utilisent les valeurs dev de votre projet.",
  },
  status: {
    ready: "Prête",
    starting: "Démarrage",
    refreshing: "Actualisation",
    stopping: "Arrêt en cours",
    stopped: "Arrêtée",
    attention: "À vérifier",
    deleting: "Suppression",
  },
  steps: {
    label: "Progression",
    preparing: "Préparation de la machine",
    copying: "Copie des données",
    starting: "Démarrage",
    done: "Terminé",
    current: "En cours",
    waiting: "Pas encore commencé",
  },
  waitingForWorker:
    "Aucun worker de branches ne l’a encore prise en charge. La production exécute les branches avec sixb worker branches.",
  dataFrom: (age: string) => `Données de production copiées ${age}`,
  dataJustNow: "Données de production copiées à l’instant",
  noData: "Aucune donnée copiée pour l’instant",
  openedBy: (name: string) => `Ouverte par ${name}`,
  openedByYou: "Ouverte par vous",
  lastUsed: (age: string) => `Utilisée ${age}`,
  actions: {
    open: "Ouvrir",
    start: "Démarrer",
    retry: "Réessayer",
    more: (name: string) => `Plus d’options pour ${name}`,
    refresh: "Actualiser depuis la production…",
    stop: "Arrêter",
    delete: "Supprimer…",
    copyError: "Copier l’erreur",
  },
  opening: "Connexion en cours…",
  openFailed: "La branche n’a pas pu être ouverte.",
  popupBlocked:
    "Votre navigateur a bloqué le nouvel onglet. Autorisez les fenêtres pour ce site et réessayez.",
  started: (name: string) => `Démarrage de ${name}`,
  stopped: (name: string) => `${name} est arrêtée`,
  refreshed: (name: string) => `Actualisation de ${name} depuis la production`,
  deleted: (name: string) => `Suppression de ${name}`,
  actionFailed: "Cela n’a pas fonctionné. Réessayez dans un instant.",
  attention: {
    code: "Le code de la branche n’a pas démarré.",
    codeHint: (file: string) => `Corrigez ${file} et poussez : la branche se recharge seule.`,
    codeHintNoFile: "Corrigez l’erreur et poussez : la branche se recharge seule.",
    machine: "La branche n’a pas pu démarrer.",
    details: "Détails",
    file: "Fichier",
  },
  notices: {
    "data-reset":
      "Sa machine a été remplacée, elle a donc repris une copie de la production. Les modifications faites sur la branche sont perdues.",
    "no-dev-env":
      "Elle tourne sans les valeurs dev de votre projet : la production n’a pas pu les lire.",
    "machine-ended": "Sa machine a atteint la limite de durée du fournisseur et s’est arrêtée.",
    "temp-files-uncapped":
      "Une requête lourde sur cette branche pourrait remplir le disque de la base de production. Demandez à qui gère cette base de laisser Sixb la plafonner (SET sur temp_file_limit).",
  },
  notCopied: {
    summary: (types: number, datasets: number) => {
      const parts = [
        ...(types > 0 ? [plural("fr", types, { one: "1 type", other: `${types} types` })] : []),
        ...(datasets > 0
          ? [
              plural("fr", datasets, {
                one: "1 jeu de données",
                other: `${datasets} jeux de données`,
              }),
            ]
          : []),
      ]
      const verb = types + datasets === 1 ? "n’a pas été copié" : "n’ont pas été copiés"
      return `${parts.join(" et ")} ${verb}`
    },
    unreadable: (name: string) => `${name} ne peut pas le lire en production.`,
    changed:
      "Sa définition a changé sur cette branche : les lignes de production n’y correspondent plus.",
    hiddenColumns: (name: string, columns: string) =>
      `${name} ne peut pas lire toutes ses colonnes (${columns}) : rien n’en a été copié.`,
    someone: "La personne qui l’a ouverte",
  },
  refresh: {
    title: (name: string) => `Actualiser ${name} depuis la production ?`,
    description:
      "Elle reprend une copie de ce que vous voyez en production maintenant. Les modifications faites sur cette branche sont perdues.",
    confirm: "Actualiser",
  },
  remove: {
    title: (name: string) => `Supprimer ${name} ?`,
    description:
      "Sa machine et sa copie des données de production sont supprimées. Votre branche git et votre code restent tels quels.",
    confirm: "Supprimer",
  },
  create: {
    title: "Ouvrir une branche",
    description:
      "La production exécute le code de la branche sur une copie de ce que vous voyez maintenant. Poussez d’abord la branche.",
    label: "Branche git",
    placeholder: "feature/invoices",
    submit: "Ouvrir la branche",
    invalid: "Saisissez le nom d’une branche git, par exemple feature/invoices.",
  },
  cancel: "Annuler",
}

const branchesMessages = defineMessages<BranchesMessages>({ en, fr })

/** Messages of Console › Branches in the current locale. */
export const useBranchesMessages = branchesMessages.useMessages
