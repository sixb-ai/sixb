/** What a user agent says about the device that signed in. Display only, never authorization. */
export interface ActivityDevice {
  readonly browser?: string
  readonly os?: string
}

// First match wins: Edge and Opera also name Chrome, Chrome names Safari, iOS names Mac OS X, and
// Android names Linux.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|Chromium|CriOS|HeadlessChrome)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
]

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bWindows\b/, "Windows"],
  [/\biPad\b/, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
]

/** The browser and operating system a user agent names, when it names a common one. */
export function describeUserAgent(userAgent: string | undefined): ActivityDevice {
  if (!userAgent) {
    return {}
  }

  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]

  return {
    ...(browser === undefined ? {} : { browser }),
    ...(os === undefined ? {} : { os }),
  }
}
