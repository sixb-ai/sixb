import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"

/** Source catalog of Settings › Activity. */
export const en = {
  title: "Activity",
  description: "Who uses the app, and the pages they view.",
  refresh: "Refresh",
  ranges: { "24h": "24h", "7d": "7d", "30d": "30d" },
  day: (date: string) => `${date} (UTC)`,
  clearDay: "Clear the day",
  utc: "UTC",
  denied: "Seeing activity takes can.observe(project.activity) in one of your roles.",
  unavailable: "The activity could not be loaded.",
  retry: "Retry",
  userFilter: "Filter by user",
  allUsers: "All users",
  users: { showMore: "Show more users" },
  metrics: {
    users: "Users",
    usersDetail: "Signed-in accounts, each counted once",
    visits: "Visits",
    visitsDetail: "Active in the period",
    sharedVisits: "Shared-link visits",
    sharedVisitsDetail: "Anonymous: a link has no account",
    pageViews: "Page views",
    pageViewsDetail: "Viewed in the period",
  },
  visits: {
    title: "Visits",
    description: "Visits active in the period, latest activity first.",
    emptyTitle: "No visits in this period",
    empty:
      "Visits appear once people use the app. Nothing is recorded until createSixb() sets activity.enabled.",
    emptyUser: "This user has no visit in this period.",
    loadMore: "Load more",
    moreFailed: "The next visits could not be loaded.",
    sharedLink: "Shared link",
    sharedLinkId: (suffix: string) => `Link ending ${suffix}`,
    pageViews: (count: number, formatted: string) =>
      plural("en", count, { one: "1 page view", other: `${formatted} page views` }),
    interactions: (count: number, formatted: string) =>
      plural("en", count, { one: "1 interaction", other: `${formatted} interactions` }),
  },
  source: {
    label: "Source",
    medium: "Medium",
    campaign: "Campaign",
    direct: "Direct",
    unspecified: "Unspecified",
    notRecorded: "Not recorded",
  },
  visit: {
    title: "Timeline",
    select: "Select a visit to see its pages, interactions, actions, workflows and Agent runs.",
    noPages: "No page was viewed: this visit only shows activity on a page opened earlier.",
    nothingOfKind: "Nothing of this kind in this visit.",
    unavailable: "This visit could not be loaded.",
    note: "Times are in UTC. Routes are patterns: their values and the page contents are not recorded. Interactions are the elements the app marks, by name. Actions, workflows and Agent runs are those the visit's session started.",
    truncated:
      "This visit did more than the timeline shows: it stops after 200 page views and interactions, or 200 recorded executions.",
    filters: {
      all: "All",
      page: "Pages",
      interaction: "Interactions",
      action: "Actions",
      workflow: "Workflows",
      agent: "Agent",
    },
    incomplete: "Not finished",
    agentRun: "Agent run",
    messages: (count: number, formatted: string) =>
      plural("en", count, { one: "1 message", other: `${formatted} messages` }),
    openRun: (name: string) => `Open the run of ${name}`,
    steps: {
      label: "Steps",
      earlier: "Before the first page view",
      again: (view: number) => `${ordinal(view)} time`,
      end: "end",
      count: (count: number, formatted: string) =>
        plural("en", count, { one: "1 step", other: `${formatted} steps` }),
    },
    openConversation: "Open the conversation, read-only",
  },
  thread: {
    untitled: "Untitled conversation",
    denied:
      "Reading other users' conversations takes can.observe(agent.threads) in one of your roles.",
    by: (name: string) => `${name}'s conversation`,
    readOnly: "Read-only",
  },
  connection: {
    label: "Connection",
    unknownDevice: "Unknown device",
    status: { active: "Active", expired: "Expired", revoked: "Revoked" },
    signedIn: (date: string) => `Signed in ${date}`,
    opened: (date: string) => `Opened ${date}`,
    lastSeen: (date: string) => `last seen ${date}`,
  },
  connections: {
    title: "Connections",
    description: "Each sign-in of this user, newest first, with the visits it opened.",
    empty: "This user has no sign-in recorded.",
    unavailable: "The connections could not be loaded.",
    visits: (count: number, formatted: string) =>
      plural("en", count, { one: "1 visit", other: `${formatted} visits` }),
    earlier: (count: number, formatted: string) =>
      plural("en", count, { one: "1 earlier visit", other: `${formatted} earlier visits` }),
    loadMore: "Load more connections",
  },
  calendar: {
    title: "Activity",
    activeDays: (count: number) =>
      plural("en", count, { one: "1 active day", other: `${count} active days` }),
    previousYear: "Previous year",
    nextYear: "Next year",
    dayLabel: (date: string, visits: number, pageViews: number) =>
      `${date}: ${plural("en", visits, { one: "1 visit", other: `${visits} visits` })}, ${plural(
        "en",
        pageViews,
        { one: "1 page view", other: `${pageViews} page views` }
      )}`,
    hint: "Days are in UTC. Select one to list its visits.",
    less: "Less",
    more: "More",
    intensity: "Shade follows the day's page views.",
    unavailable: "The calendar could not be loaded.",
  },
} satisfies MessageTree

export type ActivityMessages = typeof en

/** "2nd", "3rd", "11th". */
function ordinal(value: number): string {
  const suffixes: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" }
  const rule = new Intl.PluralRules("en", { type: "ordinal" })
  return `${value}${suffixes[rule.select(value)] ?? "th"}`
}

export const fr: Translation<ActivityMessages> = {
  title: "Activité",
  description: "Qui utilise l’app, et les pages consultées.",
  refresh: "Actualiser",
  ranges: { "24h": "24 h", "7d": "7 j", "30d": "30 j" },
  day: (date: string) => `${date} (UTC)`,
  clearDay: "Effacer le jour",
  utc: "UTC",
  denied: "Voir l’activité demande can.observe(project.activity) dans l’un de vos rôles.",
  unavailable: "L’activité n’a pas pu être chargée.",
  retry: "Réessayer",
  userFilter: "Filtrer par utilisateur",
  allUsers: "Tous les utilisateurs",
  users: { showMore: "Afficher plus d’utilisateurs" },
  metrics: {
    users: "Utilisateurs",
    usersDetail: "Comptes connectés, chacun compté une fois",
    visits: "Visites",
    visitsDetail: "Actives sur la période",
    sharedVisits: "Visites par lien partagé",
    sharedVisitsDetail: "Anonymes : un lien n’a pas de compte",
    pageViews: "Pages vues",
    pageViewsDetail: "Consultées sur la période",
  },
  visits: {
    title: "Visites",
    description: "Visites actives sur la période, de la plus récente à la plus ancienne.",
    emptyTitle: "Aucune visite sur cette période",
    empty:
      "Les visites apparaissent dès que l’app est utilisée. Rien n’est enregistré tant que createSixb() ne définit pas activity.enabled.",
    emptyUser: "Cet utilisateur n’a aucune visite sur cette période.",
    loadMore: "Charger plus",
    moreFailed: "Les visites suivantes n’ont pas pu être chargées.",
    sharedLink: "Lien partagé",
    sharedLinkId: (suffix: string) => `Lien finissant par ${suffix}`,
    pageViews: (count: number, formatted: string) =>
      plural("fr", count, { one: `${formatted} page vue`, other: `${formatted} pages vues` }),
    interactions: (count: number, formatted: string) =>
      plural("fr", count, { one: `${formatted} interaction`, other: `${formatted} interactions` }),
  },
  source: {
    label: "Source",
    medium: "Support",
    campaign: "Campagne",
    direct: "Accès direct",
    unspecified: "Non précisée",
    notRecorded: "Non enregistrée",
  },
  visit: {
    title: "Chronologie",
    select:
      "Sélectionnez une visite pour voir ses pages, interactions, actions, workflows et exécutions de l’agent.",
    noPages:
      "Aucune page consultée : cette visite ne montre que de l’activité sur une page ouverte plus tôt.",
    nothingOfKind: "Rien de ce type dans cette visite.",
    unavailable: "Cette visite n’a pas pu être chargée.",
    note: "Les heures sont en UTC. Les routes sont des modèles : leurs valeurs et le contenu des pages ne sont pas enregistrés. Les interactions sont les éléments que l’app marque, par leur nom. Les actions, workflows et exécutions de l’agent sont ceux lancés par la session de la visite.",
    truncated:
      "Cette visite en a fait plus que ce que montre la chronologie : elle s’arrête après 200 pages vues et interactions, ou 200 exécutions enregistrées.",
    filters: {
      all: "Tout",
      page: "Pages",
      interaction: "Interactions",
      action: "Actions",
      workflow: "Workflows",
      agent: "Agent",
    },
    incomplete: "Non terminée",
    agentRun: "Exécution de l’agent",
    messages: (count: number, formatted: string) =>
      plural("fr", count, { one: `${formatted} message`, other: `${formatted} messages` }),
    openRun: (name: string) => `Ouvrir l’exécution de ${name}`,
    steps: {
      label: "Étapes",
      earlier: "Avant la première page vue",
      again: (view: number) => `${view}e fois`,
      end: "fin",
      count: (count: number, formatted: string) =>
        plural("fr", count, { one: `${formatted} étape`, other: `${formatted} étapes` }),
    },
    openConversation: "Ouvrir la conversation, en lecture seule",
  },
  thread: {
    untitled: "Conversation sans titre",
    denied:
      "Lire les conversations des autres utilisateurs demande can.observe(agent.threads) dans l’un de vos rôles.",
    by: (name: string) => `Conversation de ${name}`,
    readOnly: "Lecture seule",
  },
  connection: {
    label: "Connexion",
    unknownDevice: "Appareil inconnu",
    status: { active: "Active", expired: "Expirée", revoked: "Révoquée" },
    signedIn: (date: string) => `Connecté le ${date}`,
    opened: (date: string) => `Ouvert le ${date}`,
    lastSeen: (date: string) => `vu pour la dernière fois le ${date}`,
  },
  connections: {
    title: "Connexions",
    description:
      "Chaque connexion de cet utilisateur, de la plus récente à la plus ancienne, avec les visites ouvertes.",
    empty: "Aucune connexion enregistrée pour cet utilisateur.",
    unavailable: "Les connexions n’ont pas pu être chargées.",
    visits: (count: number, formatted: string) =>
      plural("fr", count, { one: `${formatted} visite`, other: `${formatted} visites` }),
    earlier: (count: number, formatted: string) =>
      plural("fr", count, {
        one: `${formatted} visite plus ancienne`,
        other: `${formatted} visites plus anciennes`,
      }),
    loadMore: "Charger plus de connexions",
  },
  calendar: {
    title: "Activité",
    activeDays: (count: number) =>
      plural("fr", count, { one: `${count} jour actif`, other: `${count} jours actifs` }),
    previousYear: "Année précédente",
    nextYear: "Année suivante",
    dayLabel: (date: string, visits: number, pageViews: number) =>
      `${date} : ${plural("fr", visits, { one: `${visits} visite`, other: `${visits} visites` })}, ${plural(
        "fr",
        pageViews,
        { one: `${pageViews} page vue`, other: `${pageViews} pages vues` }
      )}`,
    hint: "Les jours sont en UTC. Sélectionnez-en un pour lister ses visites.",
    less: "Moins",
    more: "Plus",
    intensity: "La teinte suit les pages vues du jour.",
    unavailable: "Le calendrier n’a pas pu être chargé.",
  },
}

export const useActivityMessages = defineMessages<ActivityMessages>({ en, fr }).useMessages
