import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"

/** Source catalog of Console › Branches. */
export const en = {
  title: "Branches",
  description: "Try changes to your project on a copy of production's data before they go live.",
  newBranch: "New branch",
  loadFailed: "Branches couldn't be loaded",
  checkConnection: "Check your connection, then try again.",
  tryAgain: "Try again",
  denied: "You don't have access to Branches. Ask a project admin.",
  empty: {
    title: "No branches yet",
    description:
      "Start a git branch to run its code on a copy of what you see in production. Nothing it does reaches production.",
  },
  setup: {
    title: "Branches aren't set up yet",
    guide: "Setup guide",
    storage:
      "Branches live next to production's database. Use PostgreSQL for production's storage:",
    source: "Branches run your project's code from its git repository. Name it in sixb.config.ts:",
    sandboxes: "Each branch runs on a machine of its own. Add one in sixb.config.ts:",
    "sandbox-shares-host":
      "The local machine setting would run branches on production's own server. Use separate machines instead:",
    "sandbox-env":
      "The machine setup gives every branch its own environment variables. Remove them: branches use your project's development settings.",
  },
  status: {
    ready: "Ready",
    starting: "Starting",
    waiting: "Waiting",
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
    starting: "Starting the app",
    done: "Done",
    current: "In progress",
    waiting: "Not started",
  },
  waitingForWorker:
    "Nothing is running branches on production yet. Ask a developer to start the branch worker:",
  dataFrom: (age: string) => `Production data from ${age}`,
  dataJustNow: "Production data from just now",
  copyingData: "Copying production data…",
  noData: "No data copied yet",
  startedBy: (name: string) => `Started by ${name}`,
  startedByYou: "Started by you",
  lastOpened: (age: string) => `Last opened ${age}`,
  actions: {
    open: "Open",
    start: "Start",
    retry: "Try again",
    more: (name: string) => `More for ${name}`,
    refresh: "Refresh from production…",
    stop: "Stop",
    delete: "Delete…",
  },
  opening: "Signing you in…",
  openFailed: "The branch couldn't be opened.",
  popupBlocked: "Your browser blocked the new tab. Allow pop-ups for this site and try again.",
  started: (name: string) => `Starting ${name}`,
  ready: (name: string) => `${name} is ready`,
  stopped: (name: string) => `Stopping ${name}`,
  refreshed: (name: string) => `Refreshing ${name} from production`,
  deleted: (name: string) => `Deleting ${name}`,
  announce: (name: string, status: string) => `${name}: ${status}`,
  actionFailed: "That didn't work. Try again in a moment.",
  attention: {
    code: "The branch's code didn't start.",
    codeHint: (file: string) => `Fix ${file} and push: the branch reloads by itself.`,
    codeHintNoFile: "Fix the error and push: the branch reloads by itself.",
    machine: "The branch couldn't start.",
    details: "Details",
  },
  notices: {
    "data-reset":
      "This branch's machine was replaced, so it took a new copy of production. Changes made on the branch are gone.",
    "no-dev-env":
      "Some connected services may not work here: production can't read your project's development settings. Ask a developer to give production access to them.",
    "machine-ended": "This branch stopped at its time limit. Start it to keep going.",
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
    someone: "The person who started it",
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
      "Changes made on this branch's data are lost. The git branch and its code aren't touched.",
    confirm: "Delete branch",
  },
  create: {
    title: "New branch",
    description:
      "Production runs the branch's code on a copy of what you see now. Push the branch first.",
    label: "Git branch",
    placeholder: "feature/route-planner",
    submit: "Start branch",
    spaces: "Branch names can't contain spaces, for example feature/route-planner.",
    invalid: "That isn't a git branch name. Try one like feature/route-planner.",
  },
  cancel: "Cancel",
} satisfies MessageTree

export type BranchesMessages = typeof en

export const fr: Translation<BranchesMessages> = {
  title: "Branches",
  description:
    "Essayez les changements de votre projet sur une copie des données de production avant leur mise en ligne.",
  newBranch: "Nouvelle branche",
  loadFailed: "Les branches n’ont pas pu être chargées",
  checkConnection: "Vérifiez votre connexion, puis réessayez.",
  tryAgain: "Réessayer",
  denied: "Vous n’avez pas accès aux branches. Demandez à un administrateur du projet.",
  empty: {
    title: "Aucune branche pour l’instant",
    description:
      "Démarrez une branche git pour exécuter son code sur une copie de ce que vous voyez en production. Rien de ce qu’elle fait n’atteint la production.",
  },
  setup: {
    title: "Les branches ne sont pas encore configurées",
    guide: "Guide de configuration",
    storage:
      "Les branches vivent à côté de la base de données de production. Utilisez PostgreSQL pour le stockage de production :",
    source:
      "Les branches exécutent le code de votre projet depuis son dépôt git. Indiquez-le dans sixb.config.ts :",
    sandboxes: "Chaque branche tourne sur sa propre machine. Ajoutez-en une dans sixb.config.ts :",
    "sandbox-shares-host":
      "Le réglage de machine locale exécuterait les branches sur le serveur de production. Utilisez plutôt des machines séparées :",
    "sandbox-env":
      "La configuration des machines donne à chaque branche ses propres variables d’environnement. Retirez-les : les branches utilisent les paramètres de développement de votre projet.",
  },
  status: {
    ready: "Prête",
    starting: "Démarrage",
    waiting: "En attente",
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
    starting: "Lancement de l’app",
    done: "Terminé",
    current: "En cours",
    waiting: "Pas encore commencé",
  },
  waitingForWorker:
    "Rien n’exécute encore les branches en production. Demandez à un développeur de lancer le worker de branches :",
  dataFrom: (age: string) => `Données de production copiées ${age}`,
  dataJustNow: "Données de production copiées à l’instant",
  copyingData: "Copie des données de production…",
  noData: "Aucune donnée copiée pour l’instant",
  startedBy: (name: string) => `Démarrée par ${name}`,
  startedByYou: "Démarrée par vous",
  lastOpened: (age: string) => `Ouverte ${age}`,
  actions: {
    open: "Ouvrir",
    start: "Démarrer",
    retry: "Réessayer",
    more: (name: string) => `Plus d’options pour ${name}`,
    refresh: "Actualiser depuis la production…",
    stop: "Arrêter",
    delete: "Supprimer…",
  },
  opening: "Connexion en cours…",
  openFailed: "La branche n’a pas pu être ouverte.",
  popupBlocked:
    "Votre navigateur a bloqué le nouvel onglet. Autorisez les fenêtres pour ce site et réessayez.",
  started: (name: string) => `Démarrage de ${name}`,
  ready: (name: string) => `${name} est prête`,
  stopped: (name: string) => `Arrêt de ${name}`,
  refreshed: (name: string) => `Actualisation de ${name} depuis la production`,
  deleted: (name: string) => `Suppression de ${name}`,
  announce: (name: string, status: string) => `${name} : ${status}`,
  actionFailed: "Cela n’a pas fonctionné. Réessayez dans un instant.",
  attention: {
    code: "Le code de la branche n’a pas démarré.",
    codeHint: (file: string) => `Corrigez ${file} et poussez : la branche se recharge seule.`,
    codeHintNoFile: "Corrigez l’erreur et poussez : la branche se recharge seule.",
    machine: "La branche n’a pas pu démarrer.",
    details: "Détails",
  },
  notices: {
    "data-reset":
      "La machine de cette branche a été remplacée : elle a repris une copie de la production. Les modifications faites sur la branche sont perdues.",
    "no-dev-env":
      "Certains services connectés peuvent ne pas fonctionner ici : la production ne peut pas lire les paramètres de développement de votre projet. Demandez à un développeur de lui en donner l’accès.",
    "machine-ended":
      "Cette branche s’est arrêtée à sa limite de durée. Démarrez-la pour continuer.",
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
    someone: "La personne qui l’a démarrée",
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
      "Les modifications faites sur les données de cette branche sont perdues. La branche git et son code ne sont pas touchés.",
    confirm: "Supprimer la branche",
  },
  create: {
    title: "Nouvelle branche",
    description:
      "La production exécute le code de la branche sur une copie de ce que vous voyez maintenant. Poussez d’abord la branche.",
    label: "Branche git",
    placeholder: "feature/route-planner",
    submit: "Démarrer la branche",
    spaces: "Un nom de branche ne contient pas d’espaces, par exemple feature/route-planner.",
    invalid: "Ce n’est pas un nom de branche git. Essayez par exemple feature/route-planner.",
  },
  cancel: "Annuler",
}

const branchesMessages = defineMessages<BranchesMessages>({ en, fr })

/** Messages of Console › Branches in the current locale. */
export const useBranchesMessages = branchesMessages.useMessages
