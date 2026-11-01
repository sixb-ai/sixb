import type { AgentRunDiagnosticCode } from "@sixb/core/storage"
import type { MessageTree } from "@sixb/ui/lib/i18n"

// Numbers inside messages follow the conventions of the catalog's language.
const number = (value: number) => value.toLocaleString("en")
const count = (value: number, one: string, many = `${one}s`) =>
  `${number(value)} ${value === 1 ? one : many}`

/** English plural of a humanized name, such as an object type id. */
function plural(noun: string): string {
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value
}

/**
 * Source catalog of the agent's components: every text the chat writes itself. Names,
 * descriptions, and other content from the project or the model are shown as they are.
 */
export const en = {
  surface: {
    title: "Assistant",
    open: "Open assistant",
    resize: "Resize assistant",
    collapse: "Collapse assistant",
    dock: "Move assistant to side panel",
    expand: "Expand conversation",
    backToApp: "Back to app",
  },
  chat: {
    agentUnavailable: "Agent unavailable",
    agentLoadFailed: "Could not load the agent.",
    agentNotConfigured:
      "Configure at least one language model and grant access to the project agent.",
    conversationUnavailable: "Conversation unavailable",
    conversationGone: "This conversation is no longer available.",
    placeholder: "Ask anything",
    loadingConversation: "Loading conversation…",
    messagesLoadFailed: "Could not load this conversation.",
    threadsLoadFailed: "Could not load threads.",
    sharedThreadsLoadFailed: "Could not load the threads shared with you.",
    sendFailed: "Couldn't send your message. Please try again.",
    busy: "An answer is already in progress. Send yours when it finishes.",
    busyOther: "Someone else's message is being answered. Send yours when it finishes.",
    sandboxUnavailable: "This conversation's sandbox must be recovered before another answer.",
    retryFailed: "Couldn't retry this answer. Try again.",
    stopFailed: "Couldn't stop this answer. Try again.",
    removed: "You no longer take part in this thread.",
  },
  composer: {
    message: "Message",
    placeholder: "Send a message…",
    attachFiles: "Attach files",
    stop: "Stop generating",
    send: "Send message",
    uploadingAttachment: "Uploading attachment…",
    attachmentsFailed: (failed: number) => `${count(failed, "attachment")} failed to upload.`,
    uploading: "Uploading…",
    uploadFailed: "Upload failed",
    uploadError: "Could not upload attachment.",
    removeAttachment: (name: string) => `Remove ${name}`,
    removeUnnamedAttachment: "Remove attachment",
    addFiles: "Add files",
    dropFiles: "Drop any file here to attach it to the conversation.",
    dictationListening: "Listening…",
    dictationTranscribing: "Transcribing…",
    cancelDictation: "Cancel dictation",
    finishDictation: "Done",
    /** The `+` menu: what a message can carry besides its text. */
    add: "Add files and more",
    mention: "Mention a record",
    commands: "Commands",
  },
  /** Slash commands, typed as the whole message: `/opus`, `/ask`. */
  commands: {
    list: "Commands",
    auto: "Let Auto pick the model",
    model: (name: string) => `Use ${name}`,
    modes: {
      manual: "Ask before every action",
      "accept-edits": "Allow edits without asking",
      auto: "Run everything without asking",
    },
  },
  /** The composer's one control for how the agent works: the model and the permissions. */
  settings: {
    title: "Model and permissions",
    chip: (summary: string) => `${summary}. Change model and permissions`,
    permissions: "Permissions",
  },
  files: {
    spreadsheet: "Spreadsheet",
    image: "Image",
    pdf: "PDF",
    markdown: "Markdown",
    text: "Text",
    document: "Document",
    file: "File",
    preview: (name: string) => `Preview ${name}`,
    closePreview: (name: string) => `Close preview of ${name}`,
    open: (name: string) => `Open ${name}`,
    unknownSize: "Unknown size",
    bytes: "B",
    kilobytes: "KB",
    megabytes: "MB",
    gigabytes: "GB",
    terabytes: "TB",
  },
  context: {
    add: "Add context",
    results: (query: string) => `Search results for “${query}”`,
    hint: "Type after @ to search objects…",
    page: "Page",
    searching: "Searching…",
    empty: (query: string) => `No objects found for “${query}”`,
    remove: (label: string) => `Remove ${label} context`,
    /** A context entry with no readable name. */
    unnamed: "Context",
  },
  models: {
    unavailable: "Models unavailable",
    defaultModel: "Default model",
    search: "Search models",
    list: "Models",
    empty: "No matching models.",
    details: (name: string) => `Details about ${name}`,
    contextWindow: "Context window",
    tokens: (tokens: number) => count(tokens, "token"),
    images: "Images",
    pdf: "PDF",
    audio: "Audio",
    video: "Video",
    tools: "Tools",
    reasoning: "Reasoning",
    via: (name: string) => `Via ${name}`,
    title: "Model",
    /** With tiers: the first choice of the model list. */
    auto: "Auto",
    autoRouting: "Best model for each message",
    autoStandard: (name: string) => `Sixb uses ${name}`,
  },
  reasoning: {
    thinking: "Thinking",
    reset: "Reset reasoning effort",
    useDefault: "Use model default",
    effort: "Reasoning effort",
    levels: {
      "provider-default": "Default",
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    },
    descriptions: {
      "provider-default": "The model decides how much to think",
      none: "Answer without extended reasoning",
      minimal: "Faster for straightforward work",
      low: "Quicker, lighter answers",
      medium: "Balances speed and care",
      high: "Slower, more careful answers",
      xhigh: "Very careful answers, slower still",
      max: "The most careful answers, and the slowest",
    },
  },
  threads: {
    running: (running: number) => `${number(running)} running`,
    /** A thread the agent is at work in, on the threads page. */
    working: "Working",
    title: "Threads",
    new: "New thread",
    search: "Search threads",
    clearSearch: "Clear search",
    searchLabel: (agent: string) => `Search ${agent} threads`,
    filter: "Filter threads",
    all: "All",
    archivedFilter: (archived: number) => `Archived ${number(archived)}`,
    archived: "Archived",
    messageCount: (messages: number) => count(messages, "message"),
    /** The button in a thread's header that opens the threads page. */
    open: "All threads",
    sharedFilter: (shared: number) =>
      shared > 0 ? `Shared with me ${number(shared)}` : "Shared with me",
    sharedEmpty: "Threads others share with you appear here.",
    today: "Today",
    yesterday: "Yesterday",
    thisWeek: "This week",
    older: "Older",
    loadMoreFailed: "Could not load more threads. Try again.",
    loading: "Loading…",
    loadMore: "Load more threads",
    empty: "No matching threads.",
    none: "Your threads with the agent appear here.",
    untitled: "Untitled thread",
  },
  time: {
    now: "now",
    minutes: (minutes: number) => `${minutes}m`,
    hours: (hours: number) => `${hours}h`,
    days: (days: number) => `${days}d`,
  },
  /** The meter beside the model: how much of its limit the conversation uses. */
  contextMeter: {
    title: "Context",
    label: (used: string, limit: string) => `Context: ${used} of ${limit} tokens`,
    condensing: "Condensing…",
    condensingLabel: "Condensing the conversation",
    limit: (model: string, limit: string) =>
      `Condensed before it reaches ${model}’s ${limit}-token limit.`,
    /** What the meter calls a model it cannot name. */
    thisModel: "This model",
    cached: "Read from cache",
    lastCondensed: "Last condensed",
    justNow: "just now",
    ago: (time: string) => `${time} ago`,
  },
  transcript: {
    condensed: "Condensed conversation",
    condensing: "Condensing earlier conversation…",
    condensingLabel: "Agent is condensing earlier conversation",
    /** The provider refused a request as too long: the turn condensed the conversation, then went on. */
    condensedFull: "Context was full — condensed and continued",
    condensingFull: "Context is full — condensing to continue…",
    working: "Agent is working",
    thinking: "Thinking",
    takingLonger: "Taking a little longer",
    stopped: "Stopped.",
    stoppedAtLimit: (limit: string) => `Paused at ${limit}.`,
    limitBeforeAnswer: (limit: string) =>
      `The response reached ${limit} before producing an answer.`,
    turnLimit: "the time limit",
    turnLimitOf: (amount: number, unit: "hour" | "minute" | "second") =>
      `the ${number(amount)}-${unit} turn limit`,
    continue: "Continue",
    continuing: "Continuing…",
    tryAgain: "Try again",
    retry: "Retry",
    retrying: "Retrying…",
    notStarted: "I couldn’t get a response started.",
    contextFull:
      "This conversation is too long for this model. Start a new thread, or pick a model with a larger context.",
    notFinished: "I couldn’t finish that response.",
    interrupted: "The response was interrupted before it finished.",
    reconnecting: "Connection lost — reconnecting…",
    reconnectingLabel: "Reconnecting to the agent stream",
  },
  /** Platform diagnostics, by their stable `code`; `unknown` covers codes added later. */
  diagnostics: {
    step_limit_reached:
      "I reached the step limit before producing a final answer. Ask me to continue and I can use the work above as context.",
    output_limit_reached:
      "I ran out of room before finishing this answer. Ask me to continue, or lower the reasoning level.",
    unknown: "Something went wrong during this response.",
  } satisfies Record<AgentRunDiagnosticCode | "unknown", string>,
  activity: {
    thinking: "Thinking",
    working: "Working",
    workingThroughIt: "Working through it",
    closerLook: "Taking a closer look",
    checkingDetails: "Checking the details",
    stillWorking: "Still working",
    still: (label: string) => `Still ${lowercaseFirst(label)}`,
    using: (tool: string) => `Using ${tool}`,
    messagingAgent: "Writing to a sub-agent",
    messagingNamedAgent: (key: string) => `Messaging ${key}`,
    toldAgent: (key: string, text: string) => `Told ${key}: ${text}`,
    toldAgentShort: (key: string) => `Told ${key}`,
    answeredAgent: (key: string, text: string) => `Answered ${key}: ${text}`,
    answeredAgentShort: (key: string) => `Answered ${key}`,
    agentAsks: (key: string, text: string) => `${key} asks: ${text}`,
    messageAgentFailed: (key: string) => `Could not message ${key}`,
    reasoning: "Reasoning",
    steps: (steps: number) => count(steps, "step"),
    searchFailedHint: "Web search failed. See work details.",
    noSources: "No sources found.",
    running: "running",
    input: "Input",
    output: "Output",
    details: "Details",
    toolFailed: "The tool call failed.",
  },
  /** The sub-agents the Agent delegated to, each a card in its reply. */
  delegation: {
    card: (title: string) => `Sub-agent: ${title}`,
    group: "Sub-agents of this reply",
    count: (agents: number) => count(agents, "sub-agent"),
    working: (agents: number) => `${number(agents)} working`,
    waitingOn: (agents: number, name: string) => `${number(agents)} waiting for ${name}`,
    waitingOthers: (agents: number) => `${number(agents)} waiting`,
    later: (agents: number) =>
      agents === 1 ? "1 continues later" : `${number(agents)} continue later`,
    done: (agents: number) => `${number(agents)} finished`,
    failed: (agents: number) => `${number(agents)} failed`,
    stopped: (agents: number) => `${number(agents)} stopped`,
    states: {
      starting: "Starting…",
      working: "Working…",
      asking: "Asking the agent",
      approval: "Waiting for your approval",
      approvalOther: (name: string) => `Waiting for ${name}'s approval`,
      approvalAnyone: "Waiting for approval",
      answer: "Waiting for your answer",
      answerAnyone: "Waiting for an answer",
      resume: "Decided · continues when the agent resumes",
      done: "Finished",
      failed: "Failed",
      stopped: "Stopped",
      stopping: "Stopping…",
      ended: {
        superseded: "Didn't continue · a new message moved on first",
        expired: "Didn't continue · the request expired",
        stopped: "Didn't continue · the reply was stopped",
        replaced: "Replaced by a newer sub-agent",
      },
      timeout: "Ran out of time",
      unknown: "Delegated",
    },
    fromAgent: "Agent said",
    asks: "Asked",
    answer: "Agent answered",
    answerHint: "Your next message answers it.",
    close: "Close",
    viewRequest: "See its request below",
    stepsLater: "At work. Its steps show here once it finishes.",
    stop: "Stop",
    stopLabel: (title: string) => `Stop ${title}`,
    stopFailed: "Couldn't stop it. Try again.",
    made: "Files it made",
    given: "Files it was given",
    continued: {
      approval: "Continued after the decision",
      answer: "Continued with the answer",
    },
    noWork: "Nothing to show yet.",
    loadingWork: "Loading its work…",
    loadFailed: "Couldn't load its work.",
    elsewhere: "Its work is in the original conversation.",
    tiers: { light: "Fast", standard: "Balanced", heavy: "Thorough" },
    seconds: (seconds: number) => `${number(seconds)}s`,
    minutes: (minutes: number, seconds: number) =>
      seconds === 0 ? `${number(minutes)}m` : `${number(minutes)}m ${number(seconds)}s`,
    hours: (hours: number, minutes: number) => `${number(hours)}h ${number(minutes)}m`,
    delegating: (key: string) => `Delegating to ${key}`,
    delegated: (key: string) => `Delegated to ${key}`,
    delegatingCount: (agents: number) =>
      agents === 1 ? "Delegating to a sub-agent" : `Delegating to ${count(agents, "sub-agent")}`,
    spawnFailed: (key: string) => `Couldn't delegate to ${key}`,
    waitingFor: (key: string) => `Waiting for ${key}`,
    waitingForCount: (agents: number) => `Waiting for ${count(agents, "sub-agent")}`,
    heardFrom: (key: string) => `Heard back from ${key}`,
    heardFromCount: (agents: number) => `Heard back from ${count(agents, "sub-agent")}`,
    waitFailed: "Couldn't wait for the sub-agents",
    askedAgent: (question: string) => `Asked the agent: ${question}`,
    /** The reply's line: the sub-agents by name, and how they stand. */
    line: {
      names: (names: readonly string[]) =>
        names.length <= 1
          ? (names[0] ?? "")
          : names.length <= 3
            ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
            : `${names.slice(0, 2).join(", ")} and ${number(names.length - 2)} others`,
      starting: (agents: number): string => (agents === 1 ? "is starting" : "are starting"),
      working: (agents: number): string => (agents === 1 ? "is working" : "are working"),
      asking: (agents: number): string =>
        agents === 1 ? "is asking the agent" : "are asking the agent",
      approval: (agents: number): string =>
        agents === 1 ? "needs your approval" : "need your approval",
      answer: (agents: number): string =>
        agents === 1 ? "has a question for you" : "have a question for you",
      waitingOn: (agents: number, name: string): string =>
        `${agents === 1 ? "is" : "are"} waiting for ${name}`,
      waiting: (agents: number): string => (agents === 1 ? "is waiting" : "are waiting"),
      later: (agents: number): string => (agents === 1 ? "continues later" : "continue later"),
      done: (_agents: number): string => "finished",
      failed: (_agents: number): string => "couldn't finish",
      stopped: (agents: number): string => (agents === 1 ? "was stopped" : "were stopped"),
    },
    /** The panel that lists a reply's sub-agents and opens each one's thread. */
    panel: (agents: number) => count(agents, "sub-agent"),
    back: "All sub-agents",
    task: "Its task",
    open: (names: string) => `Open ${names}`,
  },
  web: {
    searching: "Searching the web",
    searched: "Searched the web",
    searchFailed: "Web search failed",
    searchError: "The search could not be completed.",
    reviewingResults: "Reviewing web results",
    continuingAfterFailure: "Continuing after a web search failed",
    results: (results: number) => count(results, "result"),
    webPage: "web page",
    reading: (domain: string) => `Reading ${domain}`,
    read: (domain: string) => `Read ${domain}`,
    reviewing: (domain: string) => `Reviewing ${domain}`,
    readFailed: (domain: string) => `Could not read ${domain}`,
    pageError: "The page could not be read.",
    noPageText: "No page text was returned.",
    openPage: "Open page",
    newTab: " (opens in a new tab)",
    sources: "Web search sources",
    sourcesFound: (sources: number) => `${count(sources, "source")} found`,
    viewSource: (title: string, domain: string) => `View source: ${title} (${domain})`,
    closeSource: "Close source preview",
    openSource: "Open source",
    moreSources: (more: number) => `Show ${number(more)} more ${more === 1 ? "source" : "sources"}`,
    moreSourcesChip: (more: number) => `+${count(more, "source")}`,
  },
  /** The view_file tool, for a file the agent looked at (`name` may be empty). */
  modelMedia: {
    from: (names: string) => `From ${names}`,
    openImage: "Open image",
    play: "Play",
    pause: "Pause",
    expired: "This result is no longer available.",
    more: "Show more",
    less: "Show less",
  },
  viewFile: {
    title: (name: string) => `Viewed ${name || "a file"}`,
    running: (name: string) => `Viewing ${name || "a file"}`,
    failed: (name: string) => `Couldn't view ${name || "a file"}`,
    open: (name: string) => `Open ${name}`,
  },
  /** The read tool, for a file (`name` may be empty), a skill reference, or a skill guide. */
  read: {
    file: {
      title: (name: string) => `Read ${name || "a file"}`,
      running: (name: string) => `Reading ${name || "a file"}`,
      failed: (name: string) => `Couldn't read ${name || "a file"}`,
    },
    reference: {
      title: (name: string) => `Read the ${name} reference`,
      running: (name: string) => `Reading the ${name} reference`,
      failed: (name: string) => `Couldn't read the ${name} reference`,
    },
    guide: {
      title: (name: string) => `Read the ${name} guide`,
      running: (name: string) => `Reading the ${name} guide`,
      failed: (name: string) => `Couldn't read the ${name} guide`,
    },
    /** A file of the user's memory, or of the project's when `project`. */
    memory: {
      title: (project: boolean): string => (project ? "Read project memory" : "Read memory"),
      running: (project: boolean): string =>
        project ? "Reading project memory" : "Reading memory",
      failed: (project: boolean): string =>
        project ? "Couldn't read project memory" : "Couldn't read memory",
    },
    error: "The file could not be read.",
    emptyFile: "This file is empty.",
    noContent: "No file content was returned.",
    empty: "empty",
    line: (line: number) => `line ${line}`,
    lines: (start: number, end: number) => `lines ${start}–${end}`,
    moreAvailable: (range: string) => `${range} · more available`,
  },
  /** Headlines of the agent's shell commands: past tense when done, progressive while running. */
  bash: {
    preparing: "Preparing a command",
    steps: {
      title: (steps: number) => `Ran ${count(steps, "step")}`,
      running: (steps: number) => `Running ${count(steps, "step")}`,
    },
    skillReference: {
      title: (name: string) => `Read the ${name} reference`,
      running: (name: string) => `Reading the ${name} reference`,
    },
    skillGuide: {
      title: (name: string) => `Read the ${name} guide`,
      running: (name: string) => `Reading the ${name} guide`,
    },
    skill: { title: "Read the skill guide", running: "Reading the skill guide" },
    writeFile: {
      title: (kind: string) => `Created ${kind}`,
      running: (kind: string) => `Creating ${kind}`,
    },
    fileKinds: {
      html: "an HTML file",
      json: "a JSON file",
      markdown: "a Markdown file",
      data: "a data file",
      file: "a file",
    },
    editFiles: { title: "Edited files", running: "Editing files" },
    searchFiles: { title: "Searched files", running: "Searching files" },
    runTests: { title: "Ran tests", running: "Running tests" },
    createFolder: { title: "Created a folder", running: "Creating a folder" },
    copyFiles: { title: "Copied files", running: "Copying files" },
    moveFiles: { title: "Moved files", running: "Moving files" },
    inspectFiles: { title: "Inspected files", running: "Inspecting files" },
    workspaceLocation: {
      title: "Checked the workspace location",
      running: "Checking the workspace location",
    },
    readFile: { title: "Read a file", running: "Reading a file" },
    command: { title: "Ran a command", running: "Running a command" },
    help: {
      title: (subject: string) => `Checked ${subject}`,
      running: (subject: string) => `Checking ${subject}`,
    },
    helpSubjects: {
      objects: "how to work with project data",
      ontology: "the project data model",
      telemetry: "how to work with telemetry",
      actions: "available actions",
      workflows: "available workflows",
      files: "how to work with files",
      project: "project information",
      other: "available project operations",
    },
    version: { title: "Checked the Sixb version", running: "Checking the Sixb version" },
    doctor: { title: "Checked the agent runtime", running: "Checking the agent runtime" },
    runContext: { title: "Read the run context", running: "Reading the run context" },
    history: {
      title: "Read the earlier conversation",
      running: "Reading the earlier conversation",
    },
    historyMessage: {
      title: (seq: string) => `Read message ${seq}`,
      running: (seq: string) => `Reading message ${seq}`,
    },
    ontology: { title: "Explored the ontology", running: "Exploring the ontology" },
    objectType: {
      title: (type: string) => `Inspected the ${type || "object"} type`,
      running: (type: string) => `Inspecting the ${type || "object"} type`,
    },
    inspectObject: {
      title: (object: string) => `Inspected ${object || "object"}`,
      running: (object: string) => `Inspecting ${object || "object"}`,
    },
    queriedObjects: "Queried objects",
    foundObjects: (found: number, type: string) =>
      `Found ${count(found, type || "object", plural(type || "object"))}`,
    lookingUp: (type: string) => `Looking up ${plural(type || "object")}`,
    queryExample: { title: "Read a query example", running: "Reading a query example" },
    countObjects: {
      title: (type: string) => `Counted ${plural(type || "object")}`,
      running: (type: string) => `Counting ${plural(type || "object")}`,
    },
    exists: { title: "Checked for matches", running: "Checking for matches" },
    facets: { title: "Broke down the data", running: "Breaking down the data" },
    links: {
      title: (object: string) => `Read links for ${object || "an object"}`,
      running: (object: string) => `Reading links for ${object || "an object"}`,
    },
    latestTelemetry: {
      title: (property: string) => `Read latest ${property || "telemetry"}`,
      running: (property: string) => `Reading latest ${property || "telemetry"}`,
    },
    telemetryHistory: {
      title: (property: string) => `Read ${property || "telemetry"} history`,
      running: (property: string) => `Reading ${property || "telemetry"} history`,
    },
    telemetryQuery: { title: "Compared telemetry series", running: "Comparing telemetry series" },
    listActions: { title: "Listed available actions", running: "Listing available actions" },
    inspectAction: {
      title: (action: string) => `Inspected the ${action || "action"} action`,
      running: (action: string) => `Inspecting the ${action || "action"} action`,
    },
    heldForApproval: "Waiting for approval",
    requestAction: {
      title: (action: string) => `Ran the ${action || "requested"} action`,
      running: (action: string) => `Running the ${action || "requested"} action`,
    },
    actionRun: {
      checked: "Checked an action run",
      checking: "Checking the action run",
      succeeded: (action: string) => `${capitalize(action) || "Action"} succeeded`,
      failed: (action: string) => `${capitalize(action) || "Action"} failed`,
    },
    listActionRuns: { title: "Listed action runs", running: "Listing action runs" },
    listWorkflows: { title: "Listed workflows", running: "Listing workflows" },
    inspectWorkflow: {
      title: (workflow: string) => `Inspected the ${workflow || "workflow"} workflow`,
      running: (workflow: string) => `Inspecting the ${workflow || "workflow"} workflow`,
    },
    startWorkflow: {
      title: (workflow: string) => `Started the ${workflow || "requested"} workflow`,
      running: (workflow: string) => `Starting the ${workflow || "requested"} workflow`,
    },
    listWorkflowRuns: { title: "Listed workflow runs", running: "Listing workflow runs" },
    workflowRun: { title: "Checked a workflow run", running: "Checking a workflow run" },
    listDatasets: { title: "Listed datasets", running: "Listing datasets" },
    inspectDataset: {
      title: (dataset: string) => `Inspected the ${dataset || "requested"} dataset`,
      running: (dataset: string) => `Inspecting the ${dataset || "requested"} dataset`,
    },
    datasetVersions: {
      title: (dataset: string) => `Listed versions of the ${dataset || "requested"} dataset`,
      running: (dataset: string) => `Listing versions of the ${dataset || "requested"} dataset`,
    },
    datasetRows: {
      title: (dataset: string) => `Read rows of the ${dataset || "requested"} dataset`,
      running: (dataset: string) => `Reading rows of the ${dataset || "requested"} dataset`,
    },
    listSyncs: { title: "Listed syncs", running: "Listing syncs" },
    inspectSync: {
      title: (sync: string) => `Inspected the ${sync || "requested"} sync`,
      running: (sync: string) => `Inspecting the ${sync || "requested"} sync`,
    },
    listSyncRuns: { title: "Listed sync runs", running: "Listing sync runs" },
    listPipelines: { title: "Listed pipelines", running: "Listing pipelines" },
    inspectPipeline: {
      title: (pipeline: string) => `Inspected the ${pipeline || "requested"} pipeline`,
      running: (pipeline: string) => `Inspecting the ${pipeline || "requested"} pipeline`,
    },
    listPipelineRuns: { title: "Listed pipeline runs", running: "Listing pipeline runs" },
    pipelineRun: { title: "Checked a pipeline run", running: "Checking a pipeline run" },
    upload: { title: "Uploaded a file", running: "Uploading a file" },
    download: { title: "Downloaded a file", running: "Downloading a file" },
    models: { title: "Checked the available models", running: "Checking the available models" },
    askModel: { title: "Asked another model", running: "Asking another model" },
    makeImage: {
      title: (images: number) => (images > 1 ? `Made ${number(images)} images` : "Made an image"),
      running: (images: number) =>
        images > 1 ? `Making ${number(images)} images` : "Making an image",
    },
    editImage: {
      title: (images: number) =>
        images > 1 ? `Made ${number(images)} versions of an image` : "Edited an image",
      running: (images: number) =>
        images > 1 ? `Making ${number(images)} versions of an image` : "Editing an image",
    },
    makeSpeech: { title: "Created a voice clip", running: "Creating a voice clip" },
    transcribe: { title: "Transcribed audio", running: "Transcribing audio" },
    reopenCall: { title: "Opened an earlier result", running: "Opening an earlier result" },
    project: { title: "Read project info", running: "Reading project info" },
    api: { title: "Called the Sixb API", running: "Calling the Sixb API" },
    sixbCommand: { title: "Ran a Sixb command", running: "Running a Sixb command" },
    /** Steps on the user's memory, or on the project's when `project`. */
    memorySave: {
      title: (project: boolean): string =>
        project ? "Saved to project memory" : "Saved to memory",
      running: (project: boolean): string =>
        project ? "Saving to project memory" : "Saving to memory",
    },
    memorySaveFailed: {
      title: (project: boolean): string =>
        project ? "Couldn't save to project memory" : "Couldn't save to memory",
      running: (project: boolean): string =>
        project ? "Saving to project memory" : "Saving to memory",
    },
    memoryConflict: {
      title: (project: boolean): string =>
        project ? "Found newer project memory to merge" : "Found newer memory to merge",
      running: (project: boolean): string =>
        project ? "Saving to project memory" : "Saving to memory",
    },
    memoryRead: {
      title: (project: boolean): string => (project ? "Read project memory" : "Read memory"),
      running: (project: boolean): string =>
        project ? "Reading project memory" : "Reading memory",
    },
    memoryEdit: {
      title: (project: boolean): string => (project ? "Updated project memory" : "Updated memory"),
      running: (project: boolean): string =>
        project ? "Updating project memory" : "Updating memory",
    },
    memoryPull: { title: "Checked memory", running: "Checking memory" },
    counts: {
      objectTypes: (types: number) => count(types, "object type"),
      objects: (objects: number) => count(objects, "object"),
      links: (links: number) => count(links, "link"),
      points: (points: number) => count(points, "point"),
      actions: (actions: number) => count(actions, "action"),
      runs: (runs: number) => count(runs, "run"),
      workflows: (workflows: number) => count(workflows, "workflow"),
      series: (series: number) => `${number(series)} series`,
      properties: (properties: number) => count(properties, "property", "properties"),
    },
    number: (value: number) => number(value),
    yes: "Yes",
    no: "No",
    queued: "queued",
    statuses: {
      queued: "queued",
      running: "running",
      succeeded: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    },
    moreLines: (lines: number) => `… ${count(lines, "more line", "more lines")}`,
  },
  /** Native views of shell command results. */
  results: {
    noMatchingObjects: "No matching objects.",
    noBreakdown: "No breakdown available.",
    noReadings: "No readings.",
    noSeries: "No series returned.",
    series: (index: number) => `Series ${index}`,
    properties: "Properties",
    links: "Links",
    actions: "Actions",
    queuedAgo: (time: string) => `queued ${time}`,
    startedAgo: (time: string) => `started ${time}`,
    finishedAgo: (time: string) => `finished ${time}`,
    onSubject: (subject: string) => `on ${subject}`,
    actionFailed: "The action failed.",
    inputs: "Inputs",
    noOutput: "No output.",
    outputTruncated: "Output truncated.",
    noItems: "No items returned.",
    item: (index: number) => `Item ${index}`,
    low: (value: string) => `low ${value}`,
    high: (value: string) => `high ${value}`,
    showing: (shown: number, total: number) => `Showing ${number(shown)} of ${number(total)}`,
    results: (results: number) => count(results, "result"),
    moreAvailable: "more available",
    items: (items: number) => count(items, "item"),
    value: "value",
    command: "Command",
    output: "Output",
    error: "Error",
    details: "Details",
    viewRaw: "View raw",
    hideRaw: "Hide raw",
    commandFailed: "The command failed.",
  },
  artifacts: {
    dialogTitle: "Artifact",
    dialogDescription: "View an artifact or file from this conversation.",
    canvasDescription: "View an artifact or file while you keep using the assistant.",
    list: (total: number) =>
      total === 1
        ? "1 artifact in this conversation"
        : `${number(total)} artifacts in this conversation`,
    all: "All artifacts",
    /** A `publish_artifact` call, by the title it names (`title` may be empty). */
    publishing: (title: string) => `Publishing ${title || "an artifact"}`,
    published: (title: string) => `Published ${title || "an artifact"}`,
    publishFailed: (title: string) => `Couldn't publish ${title || "an artifact"}`,
    open: (title: string) => `Open ${title}`,
    /** Labels the cards of what one response published. */
    cards: "Published in this response",
    close: "Close",
  },
  memory: {
    /** Closes a turn once per save, before what the save says the agent remembered. */
    saved: (project: boolean): string => (project ? "Saved to project memory" : "Saved to memory"),
  },
  sandbox: {
    title: "Sandbox recovery required",
    description:
      "Recovery failed or the previous operation could not be confirmed. Automatic resume is blocked to protect your work.",
    recreateFailed: "Could not recreate the sandbox. Reload and try again.",
    recreating: "Recreating…",
    startFresh: "Start with a fresh sandbox",
    confirmTitle: "Start with a fresh sandbox?",
    confirmDescription:
      "The next run will initialize a new environment. Local files from the previous workspace will not be copied. Conversation history and published attachments stay available. The previous sandbox is not deleted and remains subject to provider retention.",
    cancel: "Cancel",
    create: "Create fresh sandbox",
    ownerOnly: (owner: string) => `Only ${owner} can start this conversation with a fresh sandbox.`,
  },
  /** A conversation its owner shares with other users of the project. */
  sharing: {
    share: "Share thread",
    shareShort: "Share",
    names: (names: readonly string[]) => names.join(", "),
    people: (people: number) => `${count(people, "person", "people")} in this thread`,
    shareTitle: "Share thread",
    peopleTitle: "People in this thread",
    description: "Everyone here reads the whole thread and asks the agent with their own access.",
    inThread: "In this thread",
    owner: "Owner",
    you: "You",
    remove: (name: string) => `Remove ${name}`,
    removeFailed: "Couldn't remove this person. Try again.",
    addLabel: "Add people",
    addPlaceholder: "Add people by name or email",
    addByEmail: "Add people by email",
    addMore: "Add more",
    suggestions: "People",
    addEmail: (email: string) => `Add ${email}`,
    invalidEmail: "Enter an email address, such as colleague@example.com.",
    notFound: "No one in the project matches. Enter their email instead.",
    unstage: (name: string) => `Don't add ${name}`,
    warning:
      "They'll see the whole thread, now and later, including data the agent read with your access that they may not normally see.",
    confirm: (people: number) => `Share with ${count(people, "person", "people")}`,
    sharing: "Sharing…",
    shareRefused:
      "Couldn't add them: each must be an active member other than you, up to 50 people.",
    shareFailed: "Couldn't share this thread.",
    staged: "People to add",
    leave: "Leave thread",
    leaveTitle: "Leave this thread?",
    leaveDescription: (owner: string) =>
      `You will no longer see it or its new messages. ${owner} can add you again.`,
    leaveFailed: "Couldn't leave this thread. Try again.",
    cancel: "Cancel",
    close: "Close",
    sharedBy: (owner: string) => `${owner}'s thread`,
    /** A thread on its owner's computer: its other readers follow it, and write nothing in it. */
    onComputer: (owner: string) => `Runs on ${owner}'s computer: you can follow it here`,
    answering: (name: string) => `${name} is getting an answer…`,
    continueMine: "Continue in my own thread",
    continuing: "Copying…",
    continueHint: "A copy of the finished messages, just for you.",
    forkFailed: "Couldn't copy this thread. Try again.",
    sharedWith: (names: readonly string[]) =>
      names.length === 1
        ? `Shared with ${names[0]}`
        : names.length === 2
          ? `Shared with ${names[0]} and ${names[1]}`
          : `Shared with ${number(names.length)} people`,
    removed: (name: string) => `Removed ${name}`,
    left: "You left the thread",
    copied: "Copied to your threads",
  },
  /** What the agent may change without asking: the composer's permissions and Settings. */
  approvalModes: {
    title: "What can the agent do without asking?",
    changed: (mode: string) => `Permissions: ${mode}`,
    shortcut: "Shift+Tab in an empty message switches to the next mode",
    modes: {
      manual: {
        label: "Ask first",
        description: "Checks with you before each action or workflow.",
      },
      "accept-edits": {
        label: "Allow edits",
        description:
          "Changes your data on its own. Asks before reaching other systems or starting workflows.",
      },
      auto: {
        label: "Full access",
        description: "Runs every action and workflow without asking.",
      },
    },
    saveFailed: "Couldn't change what the agent may do. Try again.",
  },
  /** A call the agent made that waits for its requester's approval. */
  approvals: {
    card: (title: string) => `Approval request: ${title}`,
    waitingYou: "Waiting for your approval",
    waitingOther: (name: string) => `Waiting for ${name}`,
    onlyRequester: (name: string) => `Only ${name} can approve this: it runs with their access.`,
    approve: "Approve",
    approving: "Approving…",
    deny: "Deny",
    denying: "Denying…",
    alwaysAllow: "Always allow",
    /** "Always allow" on a call that reaches outside the app, which lets every such call run. */
    alwaysAllowAll: "Allow all from now on",
    alwaysAllowHint: (mode: string) => `Approves this, then sets this conversation to “${mode}”`,
    alwaysAllowAlso: (others: number) =>
      `Also approves ${count(others, "other request")} waiting in this reply.`,
    modeRaised: (mode: string) => `This conversation is now set to “${mode}”.`,
    approved: "Approved",
    running: "Running…",
    failed: "Approved, but it failed",
    notRun: "Approved, but it didn't run",
    authorityLost: "The sign-in that asked for it ended before it could run. Ask the agent again.",
    denied: "Denied",
    superseded: "Set aside",
    supersededDetail: "Didn't run: a newer message came first.",
    cancelled: "Stopped",
    cancelledDetail: "The answer was stopped. It didn't run.",
    expired: "Expired",
    expiredDetail: (days: number) => `Nobody decided within ${count(days, "day")}. It didn't run.`,
    askedForApproval: "Asked for approval",
    fromSubagent: (name: string) => `From ${name}`,
    effects: {
      ontology: "Only changes records in this app",
      writeback: "Also updates the system this record comes from",
      external: "Also acts outside this app",
      workflow: (name: string) => `Starts the ${name} workflow`,
    },
    noInput: "No details to review",
    stopWaiting: "Stop waiting",
    stoppingWaiting: "Stopping…",
    stopWaitingHint: "Sets aside every request this reply waits on. It won't continue.",
    stopFailed: "Couldn't stop waiting. Try again.",
    resume: {
      retrying: "The agent continues as soon as it can.",
      refused: "The agent couldn't continue. Send a message to pick up from here.",
    },
    failures: {
      expired: "This request expired before you decided. Ask the agent again.",
      decided: "This request was already decided.",
      failed: "Couldn't record your decision. Try again.",
    },
    composerPlaceholder: "Approve above, or reply instead",
    setsAside: (name: string) => `Sending now sets aside ${name}'s request waiting for approval.`,
    waitingThreads: (waiting: number) => `${count(waiting, "thread")} waiting for your approval`,
    threadWaiting: "Waiting for you",
  },
  /** Someone else's conversation, read with can.observe(agent.threads). */
  observed: {
    readOnly:
      "Read-only. You see everything the agent showed in this conversation, whatever your own permissions.",
    empty: "This conversation has no messages.",
    loadFailed: "Could not load this conversation.",
    responding: "The agent is answering. New messages appear when they are saved.",
  },
} satisfies MessageTree

export type AgentMessages = typeof en
