import type { MessageTree } from "../messages"

/** Source catalog of `@sixb/ui`. Every other language translates exactly these messages. */
export const en = {
  dialog: {
    close: "Close",
  },
  command: {
    title: "Command Palette",
    description: "Search for a command to run...",
  },
  combobox: {
    placeholder: "Select an option...",
    search: "Search...",
    empty: "No results found.",
    loadingMore: "Loading more...",
    loadMore: "Load more",
  },
  pagination: {
    label: "pagination",
    previous: "Previous",
    previousPage: "Go to previous page",
    next: "Next",
    nextPage: "Go to next page",
    morePages: "More pages",
  },
  breadcrumb: {
    label: "breadcrumb",
    more: "More",
  },
  carousel: {
    previous: "Previous slide",
    next: "Next slide",
  },
  sidebar: {
    title: "Sidebar",
    description: "Displays the mobile sidebar.",
    toggle: "Toggle Sidebar",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    preferences: "Preferences",
    apiReference: "API reference",
    logOut: "Log out",
  },
  theme: {
    label: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  status: {
    loading: "Loading",
    scrollToEnd: "Scroll to end",
    scrollToStart: "Scroll to start",
    copyCode: "Copy code",
    copied: "Copied",
  },
  address: {
    search: "Search address",
    line1: "Address line 1",
    line2: "Address line 2",
    city: "City",
    region: "State / region",
    postalCode: "Postal code",
    countryCode: "Country code",
    placeholder: "Search for an address…",
    suggestions: "Address suggestions",
    empty: "No addresses found.",
    loading: "Searching addresses…",
    unavailable: "Address lookup is unavailable right now.",
  },
  dictation: {
    start: "Start dictation",
    stop: "Stop dictation",
    /** Accessible label naming what is dictated, such as "Start scope of work dictation". */
    startSubject: (subject: string) => `Start ${subject} dictation`,
    stopSubject: (subject: string) => `Stop ${subject} dictation`,
    unsupportedButton: "Dictation isn't supported in this browser",
    unsupported: "Voice dictation isn't supported in this browser. You can still type instead.",
    waitingForPermission: "Waiting for microphone permission…",
    listening: "Listening… Press stop when you're finished.",
    finishing: "Finishing dictation…",
  },
  speech: {
    notAllowed:
      "Microphone access was denied. Allow microphone access in your browser settings and try again.",
    audioCapture: "No microphone is available. Connect or enable a microphone and try again.",
    noSpeech: "No speech was detected. Try again when you're ready.",
    network: "Voice dictation couldn't connect. Check your connection or type instead.",
    languageNotSupported: "Voice dictation isn't available for this language. Type instead.",
    unknown: "Voice dictation couldn't start. Try again or type instead.",
  },
} satisfies MessageTree

export type UiMessages = typeof en
