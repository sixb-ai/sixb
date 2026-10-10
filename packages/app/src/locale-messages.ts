import type { MessageTree, Translation } from "@sixb/ui/lib/i18n"

/** Source catalog of the screens Sixb generates around a custom app. */
export const en = {
  goHome: "Go home",
  reload: "Reload",
  retry: "Retry",
  notFound: {
    title: "Not found",
    detail: "The page or resource you requested does not exist.",
  },
  accessDenied: {
    title: "Access required",
    detail: "Your account is signed in, but it does not have permission to access this app.",
    signOut: "Sign out",
    signingOut: "Signing out…",
  },
  error: {
    title: "Something went wrong",
    sharedDetail: "This shared page could not be displayed.",
  },
  apiUnavailable: {
    title: "Can't reach the Sixb API",
    detail: (apiBaseUrl: string) =>
      `This app could not load your session from ${apiBaseUrl}. Check that the API is running and allows this origin, then retry.`,
  },
  shared: {
    opening: "Opening shared access…",
    verifying: "Please wait while this link is verified.",
    retryableTitle: "Unable to open this link",
    retryableDetail: "A temporary problem occurred. Please try again.",
    unavailableTitle: "Link unavailable",
    unavailableDetail: "This shared link is invalid, expired, or no longer available.",
    tryAgain: "Try again",
  },
} satisfies MessageTree

export type AppMessages = typeof en

export const fr: Translation<AppMessages> = {
  goHome: "Retour à l’accueil",
  reload: "Recharger",
  retry: "Réessayer",
  notFound: {
    title: "Page introuvable",
    detail: "La page ou la ressource demandée n’existe pas.",
  },
  accessDenied: {
    title: "Accès requis",
    detail: "Ce compte est connecté, mais n’a pas l’autorisation d’accéder à cette application.",
    signOut: "Se déconnecter",
    signingOut: "Déconnexion…",
  },
  error: {
    title: "Une erreur est survenue",
    sharedDetail: "Cette page partagée n’a pas pu être affichée.",
  },
  apiUnavailable: {
    title: "Impossible de joindre l’API Sixb",
    detail: (apiBaseUrl) =>
      `L’application n’a pas pu charger la session depuis ${apiBaseUrl}. Vérifiez que l’API est démarrée et autorise cette origine, puis réessayez.`,
  },
  shared: {
    opening: "Ouverture de l’accès partagé…",
    verifying: "Vérification du lien en cours.",
    retryableTitle: "Impossible d’ouvrir ce lien",
    retryableDetail: "Un problème temporaire est survenu. Réessayez.",
    unavailableTitle: "Lien indisponible",
    unavailableDetail: "Ce lien de partage est invalide, a expiré ou n’est plus disponible.",
    tryAgain: "Réessayer",
  },
}
