import type { Translation } from "../messages"
import type { UiMessages } from "./en"

export const fr: Translation<UiMessages> = {
  dialog: {
    close: "Fermer",
  },
  command: {
    title: "Palette de commandes",
    description: "Rechercher une commande…",
  },
  combobox: {
    placeholder: "Sélectionner une option…",
    search: "Rechercher…",
    empty: "Aucun résultat.",
    loadingMore: "Chargement…",
    loadMore: "Afficher plus",
  },
  pagination: {
    label: "Pagination",
    previous: "Précédent",
    previousPage: "Page précédente",
    next: "Suivant",
    nextPage: "Page suivante",
    morePages: "Autres pages",
  },
  breadcrumb: {
    label: "Fil d’Ariane",
    more: "Plus",
  },
  carousel: {
    previous: "Diapositive précédente",
    next: "Diapositive suivante",
  },
  sidebar: {
    title: "Barre latérale",
    description: "Affiche la barre latérale sur mobile.",
    toggle: "Afficher ou masquer la barre latérale",
    expand: "Déplier la barre latérale",
    collapse: "Replier la barre latérale",
    preferences: "Préférences",
    apiReference: "Référence de l’API",
    logOut: "Se déconnecter",
  },
  theme: {
    label: "Thème",
    light: "Clair",
    dark: "Sombre",
    system: "Système",
  },
  status: {
    loading: "Chargement",
    scrollToEnd: "Aller à la fin",
    scrollToStart: "Aller au début",
    copyCode: "Copier le code",
    copied: "Copié",
  },
  address: {
    search: "Rechercher une adresse",
    line1: "Adresse",
    line2: "Complément d’adresse",
    city: "Ville",
    region: "Région / État",
    postalCode: "Code postal",
    countryCode: "Code pays",
    placeholder: "Rechercher une adresse…",
    suggestions: "Suggestions d’adresses",
    empty: "Aucune adresse trouvée.",
    loading: "Recherche d’adresses…",
    unavailable: "La recherche d’adresse est momentanément indisponible.",
  },
  dictation: {
    start: "Démarrer la dictée",
    stop: "Arrêter la dictée",
    startSubject: (subject) => `Démarrer la dictée : ${subject}`,
    stopSubject: (subject) => `Arrêter la dictée : ${subject}`,
    unsupportedButton: "La dictée n’est pas prise en charge par ce navigateur",
    unsupported:
      "La dictée vocale n’est pas prise en charge par ce navigateur. La saisie au clavier reste possible.",
    waitingForPermission: "En attente de l’autorisation du micro…",
    listening: "Écoute en cours… Appuyez sur Arrêter pour terminer.",
    finishing: "Finalisation de la dictée…",
  },
  speech: {
    notAllowed:
      "L’accès au micro a été refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.",
    audioCapture: "Aucun micro n’est disponible. Branchez ou activez un micro, puis réessayez.",
    noSpeech: "Aucune parole n’a été détectée. Réessayez.",
    network:
      "La dictée vocale n’a pas pu se connecter. Vérifiez la connexion ou saisissez le texte.",
    languageNotSupported:
      "La dictée vocale n’est pas disponible pour cette langue. Saisissez le texte.",
    unknown: "La dictée vocale n’a pas pu démarrer. Réessayez ou saisissez le texte.",
  },
}
