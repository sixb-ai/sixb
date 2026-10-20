import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"

/** Source catalog of Observability › Activity. */
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
    title: "Pages viewed",
    select: "Select a visit to see the pages viewed in it.",
    noPages: "No page was viewed: this visit only shows activity on a page opened earlier.",
    loadMore: "Load more pages",
    unavailable: "This visit could not be loaded.",
    note: "Times are when Sixb received them, in UTC. Routes are patterns: their values and the page contents are not recorded.",
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
    title: "Pages consultées",
    select: "Sélectionnez une visite pour voir les pages consultées.",
    noPages:
      "Aucune page consultée : cette visite ne montre que de l’activité sur une page ouverte plus tôt.",
    loadMore: "Charger plus de pages",
    unavailable: "Cette visite n’a pas pu être chargée.",
    note: "Les heures sont celles de réception par Sixb, en UTC. Les routes sont des modèles : leurs valeurs et le contenu des pages ne sont pas enregistrés.",
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
