import { plural, type Translation } from "@sixb/ui/lib/i18n"
import type { AgentMessages } from "./en"

const number = (value: number) => value.toLocaleString("fr")
const count = (value: number, one: string, many = `${one}s`) =>
  `${number(value)} ${plural("fr", value, { one, other: many })}`
const quoted = (name: string) => `« ${name} »`

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value
}

const DURATION_UNITS = { hour: "heure", minute: "minute", second: "seconde" } as const

export const fr: Translation<AgentMessages> = {
  surface: {
    title: "Assistant",
    open: "Ouvrir l’assistant",
    resize: "Redimensionner l’assistant",
    collapse: "Réduire l’assistant",
    dock: "Afficher l’assistant dans le panneau latéral",
    expand: "Agrandir la conversation",
    backToApp: "Retour à l’application",
  },
  chat: {
    agentUnavailable: "Agent indisponible",
    agentLoadFailed: "Impossible de charger l’agent.",
    agentNotConfigured:
      "Configurez au moins un modèle de langage et donnez accès à l’agent du projet.",
    conversationUnavailable: "Conversation indisponible",
    conversationGone: "Cette conversation n’est plus disponible.",
    placeholder: "Poser une question",
    loadingConversation: "Chargement de la conversation…",
    messagesLoadFailed: "Impossible de charger cette conversation.",
    threadsLoadFailed: "Impossible de charger les fils.",
    sharedThreadsLoadFailed: "Impossible de charger les fils partagés avec vous.",
    sendFailed: "Le message n’a pas pu être envoyé. Réessayez.",
    busy: "Une réponse est déjà en cours. Envoyez votre message quand elle sera terminée.",
    busyOther:
      "L’agent répond au message de quelqu’un d’autre. Envoyez le vôtre quand il aura fini.",
    sandboxUnavailable:
      "L’environnement de cette conversation doit être récupéré avant une nouvelle réponse.",
    retryFailed: "Impossible de relancer cette réponse. Réessayez.",
    stopFailed: "Impossible d’arrêter cette réponse. Réessayez.",
    removed: "Vous ne participez plus à ce fil.",
  },
  composer: {
    message: "Message",
    placeholder: "Écrire un message…",
    attachFiles: "Joindre des fichiers",
    stop: "Arrêter la génération",
    send: "Envoyer le message",
    uploadingAttachment: "Envoi de la pièce jointe…",
    attachmentsFailed: (failed) =>
      failed === 1
        ? "1 pièce jointe n’a pas pu être envoyée."
        : `${number(failed)} pièces jointes n’ont pas pu être envoyées.`,
    uploading: "Envoi…",
    uploadFailed: "Échec de l’envoi",
    uploadError: "Impossible d’envoyer la pièce jointe.",
    removeAttachment: (name) => `Retirer ${name}`,
    removeUnnamedAttachment: "Retirer la pièce jointe",
    addFiles: "Ajouter des fichiers",
    dropFiles: "Déposez un fichier ici pour le joindre à la conversation.",
    dictationListening: "À l’écoute…",
    dictationTranscribing: "Transcription…",
    cancelDictation: "Annuler la dictée",
    finishDictation: "Terminer",
    add: "Ajouter des fichiers et plus",
    mention: "Mentionner un enregistrement",
    commands: "Commandes",
  },
  commands: {
    list: "Commandes",
    auto: "Laisser Auto choisir le modèle",
    model: (name) => `Utiliser ${name}`,
    modes: {
      manual: "Demander avant chaque action",
      "accept-edits": "Autoriser les modifications sans demander",
      auto: "Tout lancer sans demander",
    },
  },
  settings: {
    title: "Modèle et autorisations",
    chip: (summary) => `${summary}. Changer le modèle et les autorisations`,
    permissions: "Autorisations",
  },
  files: {
    spreadsheet: "Feuille de calcul",
    image: "Image",
    pdf: "PDF",
    markdown: "Markdown",
    text: "Texte",
    document: "Document",
    file: "Fichier",
    preview: (name) => `Aperçu de ${name}`,
    closePreview: (name) => `Fermer l’aperçu de ${name}`,
    open: (name) => `Ouvrir ${name}`,
    unknownSize: "Taille inconnue",
    bytes: "o",
    kilobytes: "Ko",
    megabytes: "Mo",
    gigabytes: "Go",
    terabytes: "To",
  },
  context: {
    add: "Ajouter du contexte",
    results: (query) => `Résultats pour ${quoted(query)}`,
    hint: "Tapez @ puis un nom pour rechercher un objet…",
    page: "Page",
    searching: "Recherche…",
    empty: (query) => `Aucun objet trouvé pour ${quoted(query)}`,
    remove: (label) => `Retirer le contexte ${label}`,
    unnamed: "Contexte",
  },
  models: {
    unavailable: "Modèles indisponibles",
    defaultModel: "Modèle par défaut",
    search: "Rechercher un modèle",
    list: "Modèles",
    empty: "Aucun modèle correspondant.",
    details: (name) => `Détails sur ${name}`,
    contextWindow: "Fenêtre de contexte",
    tokens: (tokens) => count(tokens, "jeton"),
    images: "Images",
    pdf: "PDF",
    audio: "Audio",
    video: "Vidéo",
    tools: "Outils",
    reasoning: "Raisonnement",
    via: (name) => `Via ${name}`,
    title: "Modèle",
    auto: "Auto",
    autoRouting: "Le meilleur modèle pour chaque message",
    autoStandard: (name) => `Sixb utilise ${name}`,
  },
  reasoning: {
    thinking: "Réflexion",
    reset: "Rétablir l’effort de raisonnement",
    useDefault: "Utiliser la valeur par défaut du modèle",
    effort: "Effort de raisonnement",
    levels: {
      "provider-default": "Par défaut",
      none: "Aucun",
      minimal: "Minimal",
      low: "Faible",
      medium: "Moyen",
      high: "Élevé",
      xhigh: "Très élevé",
      max: "Maximal",
    },
    descriptions: {
      "provider-default": "Le modèle décide combien réfléchir",
      none: "Répondre sans raisonnement approfondi",
      minimal: "Plus rapide pour les tâches simples",
      low: "Réponses plus rapides et plus légères",
      medium: "Équilibre entre rapidité et soin",
      high: "Réponses plus lentes et plus soignées",
      xhigh: "Réponses très soignées, encore plus lentes",
      max: "Les réponses les plus soignées, et les plus lentes",
    },
  },
  threads: {
    running: (running) => `${number(running)} en cours`,
    working: "En cours",
    title: "Fils de discussion",
    new: "Nouveau fil",
    search: "Rechercher un fil",
    clearSearch: "Effacer la recherche",
    searchLabel: (agent) => `Rechercher dans les fils avec ${agent}`,
    filter: "Filtrer les fils",
    all: "Tous",
    archivedFilter: (archived) => `Archivés ${number(archived)}`,
    archived: "Archivé",
    messageCount: (messages) => count(messages, "message"),
    open: "Tous les fils",
    sharedFilter: (shared) =>
      shared > 0 ? `Partagés avec moi ${number(shared)}` : "Partagés avec moi",
    sharedEmpty: "Les fils que d’autres partagent avec vous apparaissent ici.",
    today: "Aujourd’hui",
    yesterday: "Hier",
    thisWeek: "Cette semaine",
    older: "Plus anciens",
    loadMoreFailed: "Impossible de charger plus de fils. Réessayez.",
    loading: "Chargement…",
    loadMore: "Afficher plus de fils",
    empty: "Aucun fil correspondant.",
    none: "Vos fils avec l’assistant apparaissent ici.",
    untitled: "Fil sans titre",
  },
  time: {
    now: "à l’instant",
    minutes: (minutes) => `${minutes} min`,
    hours: (hours) => `${hours} h`,
    days: (days) => `${days} j`,
  },
  contextMeter: {
    title: "Contexte",
    label: (used, target) => `Contexte : ${used} sur ${target} jetons`,
    condensing: "Condensation…",
    condensingLabel: "Condensation de la conversation",
    priceTier: (model, ratio, tier) =>
      `${model} coûte ${ratio} au-delà de ${tier} jetons : la conversation est condensée avant.`,
    windowPastTier: (model, limit, ratio, tier) =>
      `Condensée près de la limite de ${limit} jetons de ${model}. Au-delà de ${tier} jetons, chaque appel coûte ${ratio}.`,
    window: (model, limit) =>
      `Condensée avant d’atteindre la limite de ${limit} jetons de ${model}.`,
    pastTier: (ratio, tier) =>
      `Au-delà de ${tier} jetons : chaque appel coûte ${ratio} jusqu’à la prochaine condensation.`,
    thisModel: "Ce modèle",
    cached: "Lu depuis le cache",
    limit: "Limite du modèle",
    lastCondensed: "Dernière condensation",
    justNow: "à l’instant",
    ago: (time) => `il y a ${time}`,
  },
  transcript: {
    condensed: "Conversation condensée",
    condensing: "Condensation de la conversation précédente…",
    condensingLabel: "L’agent condense la conversation précédente",
    condensedFull: "Contexte plein — condensé, puis poursuivi",
    condensingFull: "Contexte plein — condensation avant de poursuivre…",
    working: "L’agent travaille",
    thinking: "Réflexion",
    takingLonger: "Cela prend un peu plus de temps",
    stopped: "Arrêté.",
    stoppedAtLimit: (limit) => `Arrêté après avoir atteint ${limit}.`,
    limitBeforeAnswer: (limit) => `La réponse a atteint ${limit} avant d’aboutir.`,
    turnLimit: "la durée maximale",
    turnLimitOf: (amount, unit) => `la durée maximale de ${count(amount, DURATION_UNITS[unit])}`,
    continue: "Continuer",
    continuing: "Reprise…",
    tryAgain: "Réessayer",
    retry: "Réessayer",
    retrying: "Nouvelle tentative…",
    notStarted: "Je n’ai pas pu commencer à répondre.",
    contextFull:
      "Cette conversation est trop longue pour ce modèle. Ouvrez un nouveau fil, ou choisissez un modèle au contexte plus grand.",
    notFinished: "Je n’ai pas pu terminer cette réponse.",
    interrupted: "La réponse a été interrompue avant la fin.",
    reconnecting: "Connexion perdue — reconnexion…",
    reconnectingLabel: "Reconnexion au flux de l’agent",
  },
  diagnostics: {
    step_limit_reached:
      "J’ai atteint la limite d’étapes avant de produire une réponse finale. Il suffit de me demander de continuer pour reprendre ce travail.",
    output_limit_reached:
      "J’ai manqué de place pour terminer cette réponse. Il suffit de me demander de continuer, ou de baisser le niveau de raisonnement.",
    unknown: "Un problème est survenu pendant cette réponse.",
  },
  activity: {
    thinking: "Réflexion",
    working: "Travail en cours",
    workingThroughIt: "Analyse en cours",
    closerLook: "Examen approfondi",
    checkingDetails: "Vérification des détails",
    stillWorking: "Toujours en cours",
    still: (label) => `Toujours en cours : ${lowercaseFirst(label)}`,
    using: (tool) => `Utilisation de ${tool}`,
    messagingAgent: "Message à un sous-agent",
    messagingNamedAgent: (key) => `Message à ${key}`,
    toldAgent: (key, text) => `Message à ${key} : ${text}`,
    toldAgentShort: (key) => `Message envoyé à ${key}`,
    answeredAgent: (key, text) => `Réponse à ${key} : ${text}`,
    answeredAgentShort: (key) => `Réponse envoyée à ${key}`,
    agentAsks: (key, text) => `${key} demande : ${text}`,
    messageAgentFailed: (key) => `Impossible d’envoyer un message à ${key}`,
    reasoning: "Raisonnement",
    steps: (steps) => count(steps, "étape"),
    searchFailedHint: "La recherche web a échoué. Voir le détail du travail.",
    noSources: "Aucune source trouvée.",
    running: "en cours",
    input: "Entrée",
    output: "Sortie",
    details: "Détails",
    toolFailed: "L’appel de l’outil a échoué.",
  },
  delegation: {
    card: (title) => `Sous-agent : ${title}`,
    group: "Sous-agents de cette réponse",
    count: (agents) => count(agents, "sous-agent"),
    working: (agents) => `${number(agents)} en cours`,
    waitingOn: (agents, name) =>
      `${number(agents)} ${plural("fr", agents, { one: "attend", other: "attendent" })} ${name}`,
    waitingOthers: (agents) => `${number(agents)} en attente`,
    later: (agents) =>
      `${number(agents)} ${plural("fr", agents, { one: "reprendra", other: "reprendront" })} plus tard`,
    done: (agents) =>
      `${number(agents)} ${plural("fr", agents, { one: "terminé", other: "terminés" })}`,
    failed: (agents) => `${number(agents)} en échec`,
    stopped: (agents) =>
      `${number(agents)} ${plural("fr", agents, { one: "arrêté", other: "arrêtés" })}`,
    states: {
      starting: "Démarrage…",
      working: "En cours…",
      asking: "Pose une question à l’agent",
      approval: "En attente de votre approbation",
      approvalOther: (name) => `En attente de l’approbation de ${name}`,
      approvalAnyone: "En attente d’approbation",
      answer: "En attente de votre réponse",
      answerAnyone: "En attente d’une réponse",
      resume: "Décidé · reprendra quand l’agent continuera",
      done: "Terminé",
      failed: "Échec",
      stopped: "Arrêté",
      stopping: "Arrêt en cours…",
      ended: {
        superseded: "N’a pas repris · un nouveau message est passé avant",
        expired: "N’a pas repris · la demande a expiré",
        stopped: "N’a pas repris · la réponse a été arrêtée",
        replaced: "Remplacé par un sous-agent plus récent",
      },
      timeout: "Temps écoulé",
      unknown: "Délégué",
    },
    fromAgent: "L’agent a dit",
    asks: "A demandé",
    answer: "L’agent a répondu",
    answerHint: "Votre prochain message lui répond.",
    close: "Fermer",
    viewRequest: "Voir sa demande plus bas",
    stepsLater: "En cours. Ses étapes s’afficheront ici une fois terminé.",
    stop: "Arrêter",
    stopLabel: (title) => `Arrêter ${title}`,
    stopFailed: "Impossible de l’arrêter. Réessayez.",
    made: "Fichiers produits",
    given: "Fichiers reçus",
    continued: {
      approval: "A repris après la décision",
      answer: "A repris avec la réponse",
    },
    noWork: "Rien à afficher pour l’instant.",
    loadingWork: "Chargement de son travail…",
    loadFailed: "Impossible de charger son travail.",
    elsewhere: "Son travail se trouve dans la conversation d’origine.",
    tiers: { light: "Rapide", standard: "Équilibré", heavy: "Approfondi" },
    seconds: (seconds) => `${number(seconds)} s`,
    minutes: (minutes, seconds) =>
      seconds === 0 ? `${number(minutes)} min` : `${number(minutes)} min ${number(seconds)} s`,
    hours: (hours, minutes) => `${number(hours)} h ${number(minutes)} min`,
    delegating: (key) => `Délégation à ${key}`,
    delegated: (key) => `Délégué à ${key}`,
    delegatingCount: (agents) =>
      agents === 1 ? "Délégation à un sous-agent" : `Délégation à ${count(agents, "sous-agent")}`,
    spawnFailed: (key) => `Impossible de déléguer à ${key}`,
    waitingFor: (key) => `En attente de ${key}`,
    waitingForCount: (agents) => `En attente de ${count(agents, "sous-agent")}`,
    heardFrom: (key) => `Réponse de ${key}`,
    heardFromCount: (agents) => `Réponses de ${count(agents, "sous-agent")}`,
    waitFailed: "Impossible d’attendre les sous-agents",
    line: {
      names: (names) =>
        names.length <= 1
          ? (names[0] ?? "")
          : names.length <= 3
            ? `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`
            : `${names.slice(0, 2).join(", ")} et ${number(names.length - 2)} autres`,
      starting: (agents) => (agents === 1 ? "démarre" : "démarrent"),
      working: (agents) => (agents === 1 ? "travaille" : "travaillent"),
      asking: (agents) => (agents === 1 ? "interroge l’agent" : "interrogent l’agent"),
      approval: (agents) =>
        agents === 1 ? "attend votre approbation" : "attendent votre approbation",
      answer: (agents) =>
        agents === 1 ? "a une question pour vous" : "ont une question pour vous",
      waitingOn: (agents, name) => `${agents === 1 ? "attend" : "attendent"} ${name}`,
      waiting: (agents) => (agents === 1 ? "attend" : "attendent"),
      later: (agents) => (agents === 1 ? "reprendra plus tard" : "reprendront plus tard"),
      done: (agents) => (agents === 1 ? "a terminé" : "ont terminé"),
      failed: (agents) => (agents === 1 ? "n’a pas pu terminer" : "n’ont pas pu terminer"),
      stopped: (agents) => (agents === 1 ? "a été arrêté" : "ont été arrêtés"),
    },
    panel: (agents) => count(agents, "sous-agent"),
    back: "Tous les sous-agents",
    task: "Sa tâche",
    open: (names) => `Ouvrir ${names}`,
    askedAgent: (question) => `Question à l’agent : ${question}`,
  },
  web: {
    searching: "Recherche sur le web",
    searched: "Recherche web effectuée",
    searchFailed: "Échec de la recherche web",
    searchError: "La recherche n’a pas pu aboutir.",
    reviewingResults: "Analyse des résultats web",
    continuingAfterFailure: "Poursuite après l’échec d’une recherche web",
    results: (results) => count(results, "résultat"),
    webPage: "page web",
    reading: (domain) => `Lecture : ${domain}`,
    read: (domain) => `Page consultée : ${domain}`,
    reviewing: (domain) => `Analyse : ${domain}`,
    readFailed: (domain) => `Lecture impossible : ${domain}`,
    pageError: "La page n’a pas pu être lue.",
    noPageText: "Aucun texte n’a été récupéré sur cette page.",
    openPage: "Ouvrir la page",
    newTab: " (s’ouvre dans un nouvel onglet)",
    sources: "Sources de la recherche web",
    sourcesFound: (sources) =>
      `${count(sources, "source")} ${plural("fr", sources, { one: "trouvée", other: "trouvées" })}`,
    viewSource: (title, domain) => `Voir la source : ${title} (${domain})`,
    closeSource: "Fermer l’aperçu de la source",
    openSource: "Ouvrir la source",
    moreSources: (more) => `Afficher ${count(more, "autre source", "autres sources")}`,
    moreSourcesChip: (more) => `+${count(more, "source")}`,
  },
  modelMedia: {
    from: (names) => `À partir de ${names}`,
    openImage: "Ouvrir l’image",
    play: "Lire",
    pause: "Pause",
    expired: "Ce résultat n’est plus disponible.",
    more: "Afficher plus",
    less: "Afficher moins",
  },
  viewFile: {
    title: (name) => (name ? `${name} consulté` : "Fichier consulté"),
    running: (name) => (name ? `Consultation de ${name}` : "Consultation d’un fichier"),
    failed: (name) =>
      name ? `Impossible de consulter ${name}` : "Impossible de consulter le fichier",
    open: (name) => `Ouvrir ${name}`,
  },
  read: {
    file: {
      title: (name) => (name ? `${name} lu` : "Fichier lu"),
      running: (name) => (name ? `Lecture de ${name}` : "Lecture d’un fichier"),
      failed: (name) => (name ? `Impossible de lire ${name}` : "Impossible de lire le fichier"),
    },
    reference: {
      title: (name) => `Référence ${quoted(name)} consultée`,
      running: (name) => `Consultation de la référence ${quoted(name)}`,
      failed: (name) => `Impossible de lire la référence ${quoted(name)}`,
    },
    guide: {
      title: (name) => `Guide ${quoted(name)} consulté`,
      running: (name) => `Consultation du guide ${quoted(name)}`,
      failed: (name) => `Impossible de lire le guide ${quoted(name)}`,
    },
    memory: {
      title: (project) => (project ? "Mémoire du projet consultée" : "Mémoire consultée"),
      running: (project) =>
        project ? "Consultation de la mémoire du projet" : "Consultation de la mémoire",
      failed: (project) =>
        project ? "Impossible de lire la mémoire du projet" : "Impossible de lire la mémoire",
    },
    error: "Le fichier n’a pas pu être lu.",
    emptyFile: "Ce fichier est vide.",
    noContent: "Aucun contenu n’a été renvoyé.",
    empty: "vide",
    line: (line) => `ligne ${number(line)}`,
    lines: (start, end) => `lignes ${number(start)} à ${number(end)}`,
    moreAvailable: (range) => `${range} · suite disponible`,
  },
  bash: {
    preparing: "Préparation d’une commande",
    steps: {
      title: (steps) => count(steps, "étape exécutée", "étapes exécutées"),
      running: (steps) => `Exécution de ${count(steps, "étape")}`,
    },
    skillReference: {
      title: (name) => `Référence ${quoted(name)} consultée`,
      running: (name) => `Consultation de la référence ${quoted(name)}`,
    },
    skillGuide: {
      title: (name) => `Guide ${quoted(name)} consulté`,
      running: (name) => `Consultation du guide ${quoted(name)}`,
    },
    skill: {
      title: "Guide de la compétence consulté",
      running: "Consultation du guide de la compétence",
    },
    writeFile: {
      title: (kind) => `${capitalize(kind)} créé`,
      running: (kind) => `Création d’un ${kind}`,
    },
    fileKinds: {
      html: "fichier HTML",
      json: "fichier JSON",
      markdown: "fichier Markdown",
      data: "fichier de données",
      file: "fichier",
    },
    editFiles: { title: "Fichiers modifiés", running: "Modification de fichiers" },
    searchFiles: { title: "Fichiers parcourus", running: "Recherche dans les fichiers" },
    runTests: { title: "Tests exécutés", running: "Exécution des tests" },
    createFolder: { title: "Dossier créé", running: "Création d’un dossier" },
    copyFiles: { title: "Fichiers copiés", running: "Copie de fichiers" },
    moveFiles: { title: "Fichiers déplacés", running: "Déplacement de fichiers" },
    inspectFiles: { title: "Fichiers examinés", running: "Examen des fichiers" },
    workspaceLocation: {
      title: "Emplacement de l’espace de travail vérifié",
      running: "Vérification de l’emplacement de l’espace de travail",
    },
    readFile: { title: "Fichier lu", running: "Lecture d’un fichier" },
    command: { title: "Commande exécutée", running: "Exécution d’une commande" },
    help: {
      title: (subject) => `Aide consultée : ${subject}`,
      running: (subject) => `Consultation de l’aide : ${subject}`,
    },
    helpSubjects: {
      objects: "utilisation des données du projet",
      ontology: "modèle de données du projet",
      telemetry: "utilisation des mesures",
      actions: "actions disponibles",
      workflows: "workflows disponibles",
      files: "utilisation des fichiers",
      project: "informations du projet",
      other: "opérations disponibles",
    },
    version: { title: "Version de Sixb vérifiée", running: "Vérification de la version de Sixb" },
    doctor: {
      title: "Environnement de l’agent vérifié",
      running: "Vérification de l’environnement de l’agent",
    },
    runContext: { title: "Contexte d’exécution lu", running: "Lecture du contexte d’exécution" },
    history: {
      title: "Conversation précédente relue",
      running: "Lecture de la conversation précédente",
    },
    historyMessage: {
      title: (seq) => `Message ${seq} relu`,
      running: (seq) => `Lecture du message ${seq}`,
    },
    ontology: { title: "Ontologie explorée", running: "Exploration de l’ontologie" },
    objectType: {
      title: (type) => (type ? `Type ${quoted(type)} examiné` : "Type d’objet examiné"),
      running: (type) => (type ? `Examen du type ${quoted(type)}` : "Examen d’un type d’objet"),
    },
    inspectObject: {
      title: (object) => (object ? `Objet ${object} examiné` : "Objet examiné"),
      running: (object) => (object ? `Examen de l’objet ${object}` : "Examen d’un objet"),
    },
    queriedObjects: "Objets recherchés",
    foundObjects: (found, type) =>
      type
        ? `${count(found, "résultat")} dans ${quoted(type)}`
        : `${count(found, "objet")} ${plural("fr", found, { one: "trouvé", other: "trouvés" })}`,
    lookingUp: (type) => (type ? `Recherche dans ${quoted(type)}` : "Recherche d’objets"),
    queryExample: {
      title: "Exemple de requête consulté",
      running: "Consultation d’un exemple de requête",
    },
    countObjects: {
      title: (type) => (type ? `Objets ${quoted(type)} comptés` : "Objets comptés"),
      running: (type) => (type ? `Comptage des objets ${quoted(type)}` : "Comptage des objets"),
    },
    exists: { title: "Correspondances vérifiées", running: "Vérification des correspondances" },
    facets: { title: "Données ventilées", running: "Ventilation des données" },
    links: {
      title: (object) => (object ? `Liens de ${object} consultés` : "Liens de l’objet consultés"),
      running: (object) =>
        object ? `Lecture des liens de ${object}` : "Lecture des liens de l’objet",
    },
    latestTelemetry: {
      title: (property) =>
        property ? `Dernière valeur de ${quoted(property)} lue` : "Dernière mesure lue",
      running: (property) =>
        property
          ? `Lecture de la dernière valeur de ${quoted(property)}`
          : "Lecture de la dernière mesure",
    },
    telemetryHistory: {
      title: (property) =>
        property ? `Historique de ${quoted(property)} lu` : "Historique des mesures lu",
      running: (property) =>
        property
          ? `Lecture de l’historique de ${quoted(property)}`
          : "Lecture de l’historique des mesures",
    },
    telemetryQuery: {
      title: "Séries de mesures comparées",
      running: "Comparaison des séries de mesures",
    },
    listActions: {
      title: "Actions disponibles listées",
      running: "Récupération des actions disponibles",
    },
    inspectAction: {
      title: (action) => (action ? `Action ${quoted(action)} examinée` : "Action examinée"),
      running: (action) =>
        action ? `Examen de l’action ${quoted(action)}` : "Examen d’une action",
    },
    heldForApproval: "En attente d’approbation",
    requestAction: {
      title: (action) =>
        action ? `Action ${quoted(action)} exécutée` : "Action demandée exécutée",
      running: (action) =>
        action ? `Exécution de l’action ${quoted(action)}` : "Exécution de l’action demandée",
    },
    actionRun: {
      checked: "Exécution d’action vérifiée",
      checking: "Vérification de l’exécution de l’action",
      succeeded: (action) => (action ? `Action ${quoted(action)} réussie` : "Action réussie"),
      failed: (action) => (action ? `Échec de l’action ${quoted(action)}` : "Échec de l’action"),
    },
    listActionRuns: {
      title: "Exécutions d’actions listées",
      running: "Récupération des exécutions d’actions",
    },
    listWorkflows: { title: "Workflows listés", running: "Récupération des workflows" },
    inspectWorkflow: {
      title: (workflow) => (workflow ? `Workflow ${quoted(workflow)} examiné` : "Workflow examiné"),
      running: (workflow) =>
        workflow ? `Examen du workflow ${quoted(workflow)}` : "Examen d’un workflow",
    },
    startWorkflow: {
      title: (workflow) =>
        workflow ? `Workflow ${quoted(workflow)} lancé` : "Workflow demandé lancé",
      running: (workflow) =>
        workflow ? `Lancement du workflow ${quoted(workflow)}` : "Lancement du workflow demandé",
    },
    listWorkflowRuns: {
      title: "Exécutions de workflows listées",
      running: "Récupération des exécutions de workflows",
    },
    workflowRun: {
      title: "Exécution de workflow vérifiée",
      running: "Vérification d’une exécution de workflow",
    },
    listDatasets: {
      title: "Jeux de données listés",
      running: "Récupération des jeux de données",
    },
    inspectDataset: {
      title: (dataset) =>
        dataset ? `Jeu de données ${quoted(dataset)} examiné` : "Jeu de données examiné",
      running: (dataset) =>
        dataset ? `Examen du jeu de données ${quoted(dataset)}` : "Examen d’un jeu de données",
    },
    datasetVersions: {
      title: (dataset) =>
        dataset ? `Versions de ${quoted(dataset)} listées` : "Versions d’un jeu de données listées",
      running: (dataset) =>
        dataset
          ? `Récupération des versions de ${quoted(dataset)}`
          : "Récupération des versions d’un jeu de données",
    },
    datasetRows: {
      title: (dataset) =>
        dataset ? `Lignes de ${quoted(dataset)} lues` : "Lignes d’un jeu de données lues",
      running: (dataset) =>
        dataset
          ? `Lecture des lignes de ${quoted(dataset)}`
          : "Lecture des lignes d’un jeu de données",
    },
    listSyncs: { title: "Synchronisations listées", running: "Récupération des synchronisations" },
    inspectSync: {
      title: (sync) =>
        sync ? `Synchronisation ${quoted(sync)} examinée` : "Synchronisation examinée",
      running: (sync) =>
        sync ? `Examen de la synchronisation ${quoted(sync)}` : "Examen d’une synchronisation",
    },
    listSyncRuns: {
      title: "Exécutions de synchronisations listées",
      running: "Récupération des exécutions de synchronisations",
    },
    listPipelines: { title: "Pipelines listés", running: "Récupération des pipelines" },
    inspectPipeline: {
      title: (pipeline) => (pipeline ? `Pipeline ${quoted(pipeline)} examiné` : "Pipeline examiné"),
      running: (pipeline) =>
        pipeline ? `Examen du pipeline ${quoted(pipeline)}` : "Examen d’un pipeline",
    },
    listPipelineRuns: {
      title: "Exécutions de pipelines listées",
      running: "Récupération des exécutions de pipelines",
    },
    pipelineRun: {
      title: "Exécution de pipeline vérifiée",
      running: "Vérification d’une exécution de pipeline",
    },
    upload: { title: "Fichier téléversé", running: "Téléversement d’un fichier" },
    download: { title: "Fichier téléchargé", running: "Téléchargement d’un fichier" },
    models: {
      title: "Modèles disponibles consultés",
      running: "Consultation des modèles disponibles",
    },
    askModel: { title: "Autre modèle consulté", running: "Consultation d’un autre modèle" },
    makeImage: {
      title: (images) => (images > 1 ? `${images} images créées` : "Image créée"),
      running: (images) => (images > 1 ? `Création de ${images} images` : "Création d’une image"),
    },
    editImage: {
      title: (images) => (images > 1 ? `${images} versions d’une image créées` : "Image modifiée"),
      running: (images) =>
        images > 1 ? `Création de ${images} versions d’une image` : "Modification d’une image",
    },
    makeSpeech: { title: "Clip vocal créé", running: "Création d’un clip vocal" },
    transcribe: { title: "Audio transcrit", running: "Transcription de l’audio" },
    reopenCall: {
      title: "Résultat précédent ouvert",
      running: "Ouverture d’un résultat précédent",
    },
    project: {
      title: "Informations du projet consultées",
      running: "Lecture des informations du projet",
    },
    api: { title: "API Sixb appelée", running: "Appel de l’API Sixb" },
    sixbCommand: { title: "Commande Sixb exécutée", running: "Exécution d’une commande Sixb" },
    memorySave: {
      title: (project) =>
        project ? "Enregistré dans la mémoire du projet" : "Enregistré en mémoire",
      running: (project) =>
        project ? "Enregistrement dans la mémoire du projet" : "Enregistrement en mémoire",
    },
    memorySaveFailed: {
      title: (project) =>
        project
          ? "Impossible d’enregistrer dans la mémoire du projet"
          : "Impossible d’enregistrer en mémoire",
      running: (project) =>
        project ? "Enregistrement dans la mémoire du projet" : "Enregistrement en mémoire",
    },
    memoryPull: { title: "Mémoire vérifiée", running: "Vérification de la mémoire" },
    memoryConflict: {
      title: (project) =>
        project ? "Mémoire du projet plus récente à fusionner" : "Mémoire plus récente à fusionner",
      running: (project) =>
        project ? "Enregistrement dans la mémoire du projet" : "Enregistrement en mémoire",
    },
    memoryRead: {
      title: (project) => (project ? "Mémoire du projet consultée" : "Mémoire consultée"),
      running: (project) =>
        project ? "Consultation de la mémoire du projet" : "Consultation de la mémoire",
    },
    memoryEdit: {
      title: (project) => (project ? "Mémoire du projet mise à jour" : "Mémoire mise à jour"),
      running: (project) =>
        project ? "Mise à jour de la mémoire du projet" : "Mise à jour de la mémoire",
    },
    counts: {
      objectTypes: (types) => count(types, "type d’objet", "types d’objets"),
      objects: (objects) => count(objects, "objet"),
      links: (links) => count(links, "lien"),
      points: (points) => count(points, "point"),
      actions: (actions) => count(actions, "action"),
      runs: (runs) => count(runs, "exécution"),
      workflows: (workflows) => count(workflows, "workflow"),
      series: (series) => count(series, "série"),
      properties: (properties) => count(properties, "propriété"),
    },
    number: (value) => number(value),
    yes: "Oui",
    no: "Non",
    queued: "en file d’attente",
    statuses: {
      queued: "en file d’attente",
      running: "en cours",
      succeeded: "réussie",
      failed: "en échec",
      cancelled: "annulée",
    },
    moreLines: (lines) => `… ${count(lines, "ligne supplémentaire", "lignes supplémentaires")}`,
  },
  results: {
    noMatchingObjects: "Aucun objet correspondant.",
    noBreakdown: "Aucune ventilation disponible.",
    noReadings: "Aucune mesure.",
    noSeries: "Aucune série renvoyée.",
    series: (index) => `Série ${index}`,
    properties: "Propriétés",
    links: "Liens",
    actions: "Actions",
    queuedAgo: (time) => `en file d’attente (${time})`,
    startedAgo: (time) => `démarrée (${time})`,
    finishedAgo: (time) => `terminée (${time})`,
    onSubject: (subject) => `sur ${subject}`,
    actionFailed: "L’action a échoué.",
    inputs: "Paramètres",
    noOutput: "Aucune sortie.",
    outputTruncated: "Sortie tronquée.",
    noItems: "Aucun élément renvoyé.",
    item: (index) => `Élément ${index}`,
    low: (value) => `min. ${value}`,
    high: (value) => `max. ${value}`,
    showing: (shown, total) => `${number(shown)} sur ${number(total)}`,
    results: (results) => count(results, "résultat"),
    moreAvailable: "suite disponible",
    items: (items) => count(items, "élément"),
    value: "valeur",
    command: "Commande",
    output: "Sortie",
    error: "Erreur",
    details: "Détails",
    viewRaw: "Voir la sortie brute",
    hideRaw: "Masquer la sortie brute",
    commandFailed: "La commande a échoué.",
  },
  artifacts: {
    dialogTitle: "Artefact",
    dialogDescription: "Afficher un artefact ou un fichier de cette conversation.",
    canvasDescription:
      "Afficher un artefact ou un fichier tout en continuant d’utiliser l’assistant.",
    list: (total) =>
      total === 1
        ? "1 artefact dans cette conversation"
        : `${number(total)} artefacts dans cette conversation`,
    all: "Tous les artefacts",
    publishing: (title) => (title ? `Publication de ${title}` : "Publication d’un artefact"),
    published: (title) => (title ? `${title} publié` : "Artefact publié"),
    publishFailed: (title) =>
      title ? `Impossible de publier ${title}` : "Impossible de publier l’artefact",
    open: (title) => `Ouvrir ${title}`,
    cards: "Publié dans cette réponse",
    close: "Fermer",
  },
  memory: {
    saved: (project) =>
      project ? "Enregistré dans la mémoire du projet" : "Enregistré en mémoire",
  },
  sandbox: {
    title: "Récupération de l’environnement requise",
    description:
      "La récupération a échoué ou l’opération précédente n’a pas pu être confirmée. La reprise automatique est bloquée pour protéger le travail en cours.",
    recreateFailed: "Impossible de recréer l’environnement. Rechargez la page et réessayez.",
    recreating: "Recréation…",
    startFresh: "Repartir d’un nouvel environnement",
    confirmTitle: "Repartir d’un nouvel environnement ?",
    confirmDescription:
      "La prochaine exécution initialisera un nouvel environnement. Les fichiers locaux de l’espace de travail précédent ne seront pas copiés. L’historique de la conversation et les pièces jointes publiées restent disponibles. L’environnement précédent n’est pas supprimé et reste soumis à la politique de conservation du fournisseur.",
    cancel: "Annuler",
    create: "Créer un nouvel environnement",
    ownerOnly: (owner) =>
      `${owner} est la seule personne à pouvoir faire repartir cette conversation d’un nouvel environnement.`,
  },
  sharing: {
    share: "Partager le fil",
    shareShort: "Partager",
    names: (names) => names.join(", "),
    people: (people) => `${count(people, "personne")} dans ce fil`,
    shareTitle: "Partager le fil",
    peopleTitle: "Personnes dans ce fil",
    description: "Chaque personne ici lit tout le fil et interroge l’agent avec ses propres accès.",
    inThread: "Dans ce fil",
    owner: "Propriétaire",
    you: "Vous",
    remove: (name) => `Retirer ${name}`,
    removeFailed: "Impossible de retirer cette personne. Réessayez.",
    addLabel: "Ajouter des personnes",
    addPlaceholder: "Ajouter des personnes par nom ou e-mail",
    addByEmail: "Ajouter des personnes par e-mail",
    addMore: "Ajouter d’autres personnes",
    suggestions: "Personnes",
    addEmail: (email) => `Ajouter ${email}`,
    invalidEmail: "Saisissez une adresse e-mail, par exemple collegue@example.com.",
    notFound: "Personne dans le projet ne correspond. Saisissez plutôt son e-mail.",
    unstage: (name) => `Ne pas ajouter ${name}`,
    warning:
      "Elles verront tout le fil, maintenant et ensuite, y compris les données que l’agent a lues avec vos accès et qu’elles ne voient pas d’habitude.",
    confirm: (people) => `Partager avec ${count(people, "personne")}`,
    sharing: "Partage…",
    shareRefused:
      "Impossible de les ajouter : chacun doit être un membre actif autre que vous, dans la limite de 50 personnes.",
    shareFailed: "Impossible de partager ce fil.",
    staged: "Personnes à ajouter",
    leave: "Quitter le fil",
    leaveTitle: "Quitter ce fil ?",
    leaveDescription: (owner) =>
      `Vous ne le verrez plus, ni ses nouveaux messages. ${owner} peut vous ajouter à nouveau.`,
    leaveFailed: "Impossible de quitter ce fil. Réessayez.",
    cancel: "Annuler",
    close: "Fermer",
    sharedBy: (owner) => `Fil de ${owner}`,
    onComputer: (owner) => `Tourne sur l’ordinateur de ${owner} : vous pouvez le suivre ici`,
    answering: (name) => `L’agent répond à ${name}…`,
    continueMine: "Continuer dans mon propre fil",
    continuing: "Copie…",
    continueHint: "Une copie des messages terminés, rien qu’à vous.",
    forkFailed: "Impossible de copier ce fil. Réessayez.",
    sharedWith: (names) =>
      names.length === 1
        ? `Partagé avec ${names[0]}`
        : names.length === 2
          ? `Partagé avec ${names[0]} et ${names[1]}`
          : `Partagé avec ${number(names.length)} personnes`,
    removed: (name) => `${name} ne fait plus partie du fil`,
    left: "Vous avez quitté le fil",
    copied: "Copié dans vos fils",
  },
  approvalModes: {
    title: "Que peut faire l’agent sans demander ?",
    changed: (mode) => `Autorisations : ${mode}`,
    shortcut: "Maj+Tab dans un message vide passe au mode suivant",
    modes: {
      manual: {
        label: "Demander d’abord",
        description: "Vous demande avant chaque action ou workflow.",
      },
      "accept-edits": {
        label: "Modifications permises",
        description:
          "Modifie vos données de lui-même. Demande avant de contacter d’autres systèmes ou de lancer un workflow.",
      },
      auto: {
        label: "Accès complet",
        description: "Lance toutes les actions et tous les workflows sans demander.",
      },
    },
    saveFailed: "Impossible de changer ce que l’agent peut faire. Réessayez.",
  },
  approvals: {
    card: (title) => `Demande d’approbation : ${title}`,
    waitingYou: "En attente de votre approbation",
    waitingOther: (name) => `En attente de ${name}`,
    onlyRequester: (name) =>
      `Cette demande ne peut être approuvée que par ${name} : elle s’exécute avec ses accès.`,
    approve: "Approuver",
    approving: "Approbation…",
    deny: "Refuser",
    denying: "Refus…",
    alwaysAllow: "Toujours autoriser",
    alwaysAllowAll: "Tout autoriser désormais",
    alwaysAllowHint: (mode) =>
      `Approuve cette demande, puis règle cette conversation sur « ${mode} »`,
    alwaysAllowAlso: (others) =>
      others === 1
        ? "Approuve aussi une autre demande en attente dans cette réponse."
        : `Approuve aussi ${number(others)} autres demandes en attente dans cette réponse.`,
    modeRaised: (mode) => `Cette conversation est désormais réglée sur « ${mode} ».`,
    approved: "Approuvé",
    running: "Exécution…",
    failed: "Approuvé, mais en échec",
    notRun: "Approuvé, mais non exécuté",
    authorityLost:
      "La connexion qui l’a demandé a pris fin avant l’exécution. Redemandez à l’agent.",
    denied: "Refusé",
    superseded: "Mis de côté",
    supersededDetail: "Non exécuté : un message plus récent est passé avant.",
    cancelled: "Arrêté",
    cancelledDetail: "La réponse a été arrêtée. Rien n’a été exécuté.",
    expired: "Expiré",
    expiredDetail: (days) => `Personne n’a décidé en ${count(days, "jour")}. Rien n’a été exécuté.`,
    askedForApproval: "Approbation demandée",
    fromSubagent: (name: string) => `De ${name}`,
    effects: {
      ontology: "Ne modifie que des données de cette app",
      writeback: "Met aussi à jour le système d’où vient cet enregistrement",
      external: "Agit aussi en dehors de cette app",
      workflow: (name) => `Démarre le workflow ${quoted(name)}`,
    },
    noInput: "Aucun détail à vérifier",
    stopWaiting: "Ne plus attendre",
    stoppingWaiting: "Arrêt…",
    stopWaitingHint:
      "Met de côté toutes les demandes que cette réponse attend. Elle ne reprendra pas.",
    stopFailed: "Impossible d’arrêter l’attente. Réessayez.",
    resume: {
      retrying: "L’agent reprendra dès que possible.",
      refused: "L’agent n’a pas pu continuer. Envoyez un message pour reprendre d’ici.",
    },
    failures: {
      expired: "Cette demande a expiré avant votre décision. Redemandez à l’agent.",
      decided: "Cette demande a déjà été tranchée.",
      failed: "Impossible d’enregistrer votre décision. Réessayez.",
    },
    composerPlaceholder: "Approuvez ci-dessus, ou répondez",
    setsAside: (name) =>
      `Envoyer maintenant met de côté la demande de ${name} en attente d’approbation.`,
    waitingThreads: (waiting) => `${count(waiting, "fil")} en attente de votre approbation`,
    threadWaiting: "En attente de vous",
  },
  observed: {
    readOnly:
      "Lecture seule. Vous voyez tout ce que l’agent a montré dans cette conversation, quelles que soient vos propres permissions.",
    empty: "Cette conversation n’a aucun message.",
    loadFailed: "Impossible de charger cette conversation.",
    responding: "L’agent répond. Les nouveaux messages apparaissent une fois enregistrés.",
  },
}
