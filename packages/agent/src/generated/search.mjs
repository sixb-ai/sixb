// src/tools/search/request.ts
var SEARCH_LIMITS = {
  files: 100,
  lines: 100,
  linesPerFile: 20,
  lineCharacters: 500,
  matchLead: 40,
  matchCharacters: 4000,
  textBytes: 24 * 1024,
  fileBytes: 10 * 1024 * 1024,
  binaryProbeBytes: 8 * 1024
};

class SearchError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SearchError";
  }
}

// src/tools/search/search.ts
import { Buffer as Buffer3 } from "node:buffer";
import { lstatSync as lstatSync2, realpathSync, statSync as statSync2 } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

// src/tools/search/pattern.ts
var MAX_ALTERNATIVES = 256;

class PatternError extends Error {
}
function pathPatternSource(pattern) {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]*/)*";
      return;
    }
    source += segmentSource(segment);
    if (!last)
      source += "/";
  });
  return source;
}
function segmentSource(segment) {
  let source = "";
  for (let index = 0;index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\") {
      index += 1;
      source += escapeRegExp(segment[index] ?? "\\");
    } else if (char === "*") {
      while (segment[index + 1] === "*")
        index += 1;
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const parsed = characterClass(segment, index);
      if (parsed) {
        source += parsed.source;
        index = parsed.end;
      } else {
        source += "\\[";
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}
function characterClass(segment, start) {
  let index = start + 1;
  const negated = segment[index] === "!" || segment[index] === "^";
  if (negated)
    index += 1;
  let body = "";
  if (segment[index] === "]") {
    body += "\\]";
    index += 1;
  }
  for (;index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "]") {
      return { source: negated ? `[^/${body}]` : `[${body}]`, end: index };
    }
    if (char === "\\" && index + 1 < segment.length) {
      index += 1;
      body += escapeClassChar(segment[index]);
    } else {
      body += char === "-" ? "-" : escapeClassChar(char);
    }
  }
  return;
}
function expandBraces(pattern) {
  const expanded = [];
  expandInto(pattern, expanded);
  return expanded;
}
function expandInto(pattern, into) {
  for (let index = 0;index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "{")
      continue;
    const group = braceGroup(pattern, index);
    if (!group)
      continue;
    const prefix = pattern.slice(0, index);
    const suffix = pattern.slice(group.end + 1);
    for (const option of group.options)
      expandInto(`${prefix}${option}${suffix}`, into);
    return;
  }
  if (into.length >= MAX_ALTERNATIVES) {
    throw new PatternError(`it names more than ${MAX_ALTERNATIVES} alternatives with {…}`);
  }
  into.push(pattern);
}
function braceGroup(pattern, start) {
  const options = [];
  let depth = 0;
  let optionStart = start + 1;
  for (let index = start + 1;index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      options.push(pattern.slice(optionStart, index));
      optionStart = index + 1;
    } else if (char === "}") {
      if (options.length === 0)
        return;
      options.push(pattern.slice(optionStart, index));
      return { options, end: index };
    }
  }
  return;
}
function compilePattern(source, flags = "") {
  try {
    return new RegExp(`^${source}$`, flags);
  } catch (error) {
    throw new PatternError(error instanceof Error ? error.message : String(error));
  }
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
function escapeClassChar(char) {
  return /[\\\]^[-]/.test(char) ? `\\${char}` : char;
}

// src/tools/search/glob.ts
function compileGlob(pattern) {
  const alternatives = expandBraces(pattern).map(compileAlternative);
  const segments = alternatives.flatMap((alternative) => alternative.segments);
  const folderSegments = new Map;
  const segmentMatches = (patternSegment, name) => {
    let regex = folderSegments.get(patternSegment);
    if (!regex) {
      regex = compilePattern(segmentSource(patternSegment));
      folderSegments.set(patternSegment, regex);
    }
    return regex.test(name);
  };
  return {
    matches(relativePath) {
      const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
      return alternatives.some((alternative) => alternative.regex.test(alternative.anyDepth ? name : relativePath));
    },
    mayContain(relativeFolder) {
      const names = relativeFolder.split("/");
      return alternatives.some((alternative) => {
        if (alternative.anyDepth)
          return true;
        for (const [index, name] of names.entries()) {
          const segment = alternative.segments[index];
          if (segment === undefined)
            return false;
          if (segment === "**")
            return true;
          if (!segmentMatches(segment, name))
            return false;
        }
        return alternative.segments.length > names.length;
      });
    },
    namesHidden: segments.some((segment) => segment.startsWith(".")),
    namesNodeModules: segments.some((segment) => segment.includes("node_modules"))
  };
}
function compileAlternative(pattern) {
  let relative = pattern;
  while (relative.startsWith("./"))
    relative = relative.slice(2);
  const anchored = relative.startsWith("/");
  if (anchored)
    relative = relative.replace(/^\/+/, "");
  if (!relative)
    throw new PatternError("it names no file");
  const anyDepth = !anchored && !relative.includes("/");
  const segments = relative.split("/");
  return {
    anyDepth,
    regex: compilePattern(anyDepth ? segmentSource(relative) : pathPatternSource(relative)),
    segments
  };
}

// src/tools/search/match.ts
function textMatcher(pattern, literal) {
  return literal ? literalMatcher(pattern) : regexMatcher(pattern);
}
function literalMatcher(pattern) {
  const ignoreCase = !/\p{Lu}/u.test(pattern);
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  return {
    line(line) {
      const matched = linePrefix(line, SEARCH_LIMITS.matchCharacters);
      const index = (ignoreCase ? matched.toLowerCase() : matched).indexOf(needle);
      return index < 0 ? undefined : { index: Math.min(index, line.length), length: needle.length };
    },
    mayMatch(text) {
      if (!ignoreCase)
        return text.includes(needle);
      if (hasLineOver(text, SEARCH_LIMITS.matchCharacters))
        return true;
      return text.toLowerCase().includes(needle);
    }
  };
}
function regexMatcher(pattern) {
  const regex = lineRegex(pattern);
  const whole = wholeTextRegex(pattern, regex);
  return {
    line(line) {
      const found = regex.exec(linePrefix(line, SEARCH_LIMITS.matchCharacters));
      return found ? { index: found.index, length: found[0].length } : undefined;
    },
    mayMatch(text) {
      if (!whole || !linesAreWhole(text))
        return true;
      return whole.test(text);
    }
  };
}
function lineRegex(pattern) {
  const written = pattern.replace(/\\(?:[pP]\{[^}]*\}|.)/g, "");
  const flags = /\p{Lu}/u.test(written) || /\\[pP]\{/.test(pattern) ? "" : "i";
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {}
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchError("invalid_pattern", message.replace(/^Invalid regular expression: (?:\/.*\/[a-z]*: )?/, ""));
  }
}
function wholeTextRegex(pattern, line) {
  if (!readsOneLine(pattern))
    return;
  return new RegExp(line.source, `${line.flags}m`);
}
function linesAreWhole(text) {
  return !hasLineOver(text, SEARCH_LIMITS.matchCharacters) && !hasLoneBreak(text);
}
function hasLoneBreak(text) {
  if (text.includes("\u2028") || text.includes("\u2029"))
    return true;
  for (let index = text.indexOf("\r");index >= 0; index = text.indexOf("\r", index + 1)) {
    if (text.charCodeAt(index + 1) !== LINE_FEED)
      return true;
  }
  return false;
}
var LINE_FEED = 10;
var ESCAPES = new Set(["b", "B", "d", "w", "S", "k"]);
var CLASS_ESCAPES = new Set(["d", "w", "S"]);
function readsOneLine(pattern) {
  let inClass = false;
  let previous;
  for (let index = 0;index < pattern.length; index += 1) {
    let code = pattern.charCodeAt(index);
    if (isLineBreakOrControl(code))
      return false;
    if (code === BACKSLASH) {
      index += 1;
      const escaped = pattern[index] ?? "";
      if (/[A-Za-z0-9]/.test(escaped)) {
        if (!(inClass ? CLASS_ESCAPES : ESCAPES).has(escaped))
          return false;
        previous = undefined;
        continue;
      }
      code = pattern.charCodeAt(index);
      if (isLineBreakOrControl(code))
        return false;
    } else if (!inClass && code === OPEN_PAREN) {
      if (LOOKAROUND_OR_MODIFIER.test(pattern.slice(index, index + 4)))
        return false;
    } else if (!inClass && code === OPEN_BRACKET) {
      if (pattern[index + 1] === "^")
        return false;
      inClass = true;
      previous = undefined;
      continue;
    } else if (inClass && code === CLOSE_BRACKET) {
      inClass = false;
      continue;
    } else if (inClass && code === DASH && previous !== undefined && index + 1 < pattern.length) {
      const end = pattern[index + 1] === "\\" ? pattern.charCodeAt(index + 2) : pattern.charCodeAt(index + 1);
      if (previous <= 8233 && end >= 8232)
        return false;
    }
    previous = inClass ? code : undefined;
  }
  return true;
}
var LOOKAROUND_OR_MODIFIER = /^\(\?(?:[=!]|<[=!]|[ims-])/;
var OPEN_PAREN = 40;
var BACKSLASH = 92;
var OPEN_BRACKET = 91;
var CLOSE_BRACKET = 93;
var DASH = 45;
function isLineBreakOrControl(code) {
  return code < 32 || code === 8232 || code === 8233;
}
function hasLineOver(text, length) {
  if (text.length <= length)
    return false;
  for (let start = 0;start <= text.length; ) {
    const newline = text.indexOf(`
`, start);
    const end = newline < 0 ? text.length : newline;
    if (end - start > length)
      return true;
    start = end + 1;
  }
  return false;
}
function lines(text) {
  const split = text.split(`
`);
  if (split.at(-1) === "")
    split.pop();
  return split.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}
function cutLine(line, match) {
  const budget = SEARCH_LIMITS.lineCharacters;
  if (line.length <= budget)
    return line;
  const room = budget - 1;
  const start = match.index + match.length <= budget ? 0 : Math.max(0, Math.min(match.index - SEARCH_LIMITS.matchLead, line.length - room));
  if (start === 0)
    return `${linePrefix(line, budget)}…`;
  const from = isLowSurrogate(line.charCodeAt(start)) ? start + 1 : start;
  const window = linePrefix(line.slice(from, from + room + 1), room);
  return `…${window}${from + window.length < line.length ? "…" : ""}`;
}
function isLowSurrogate(code) {
  return code >= 56320 && code <= 57343;
}
function linePrefix(line, length) {
  if (line.length <= length)
    return line;
  const code = line.charCodeAt(length - 1);
  return line.slice(0, code >= 55296 && code <= 56319 ? length - 1 : length);
}

// src/tools/search/read.ts
import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
async function openText(path, strict) {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    if (size > SEARCH_LIMITS.fileBytes) {
      await closeQuietly(file);
      return settled({ skipped: "too_large" });
    }
    const opened = file;
    return {
      bytes: size,
      read: () => readText(opened, size, strict),
      close: () => closeQuietly(opened)
    };
  } catch {
    if (file)
      await closeQuietly(file);
    return settled({ skipped: "unreadable" });
  }
}
function settled(text) {
  return { bytes: 0, read: async () => text, close: async () => {} };
}
async function readText(file, size, strict) {
  try {
    const first = size <= READ_AT_ONCE_BYTES ? size : PROBE_BYTES;
    let bytes = await readBytes(file, Buffer.allocUnsafe(first), 0);
    if (bytes.subarray(0, PROBE_BYTES).includes(0))
      return { skipped: "binary" };
    if (bytes.length === first && first < size) {
      const whole = Buffer.allocUnsafe(size);
      bytes.copy(whole);
      bytes = await readBytes(file, whole, first);
    }
    let text;
    if (strict) {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { skipped: "binary" };
      }
    } else {
      text = bytes.toString("utf8");
    }
    return { text: text.startsWith("\uFEFF") ? text.slice(1) : text };
  } catch {
    return { skipped: "unreadable" };
  } finally {
    await closeQuietly(file);
  }
}
var PROBE_BYTES = SEARCH_LIMITS.binaryProbeBytes;
var READ_AT_ONCE_BYTES = 64 * 1024;
async function readBytes(file, bytes, from) {
  let filled = from;
  while (filled < bytes.length) {
    const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, filled);
    if (bytesRead === 0)
      break;
    filled += bytesRead;
  }
  return bytes.subarray(0, filled);
}
async function closeQuietly(file) {
  await file.close().catch(() => {});
}
var READ_AHEAD = 32;
var READ_AHEAD_BYTES = 16 * 1024 * 1024;

class ReadAhead {
  items;
  open;
  holdsNothing;
  #slots = [];
  #held = 0;
  #exhausted = false;
  #stopped = false;
  constructor(items, open, holdsNothing = () => false) {
    this.items = items;
    this.open = open;
    this.holdsNothing = holdsNothing;
  }
  async next() {
    this.#fill();
    const slot = this.#slots[0];
    if (!slot)
      return;
    await slot.opening;
    this.#start();
    const read = await slot.result;
    this.#slots.shift();
    this.#held -= slot.holds;
    this.#fill();
    this.#start();
    return { item: slot.item, read };
  }
  async stop() {
    this.#exhausted = true;
    this.#stopped = true;
    await Promise.all(this.#slots.splice(0).map(async (slot) => {
      await slot.opening;
      if (slot.result)
        await slot.result;
      else
        await slot.pending?.close();
    }));
  }
  #fill() {
    while (!this.#exhausted && this.#slots.length < READ_AHEAD) {
      const step = this.items.next();
      if (step.done) {
        this.#exhausted = true;
        return;
      }
      const slot = { item: step.value, holds: 0 };
      this.#slots.push(slot);
      slot.opening = this.open(step.value).then((pending) => {
        slot.pending = pending;
        this.#start();
      });
    }
  }
  #start() {
    if (this.#stopped)
      return;
    for (let index = 0;index < this.#slots.length; index += 1) {
      const slot = this.#slots[index];
      const pending = slot.pending;
      if (slot.result || !pending)
        continue;
      if (index > 0 && this.#held + pending.bytes > READ_AHEAD_BYTES)
        continue;
      slot.holds = pending.bytes;
      this.#held += slot.holds;
      slot.result = pending.read().then((result) => {
        if (this.holdsNothing(result) && this.#slots.includes(slot)) {
          this.#held -= slot.holds;
          slot.holds = 0;
          this.#start();
        }
        return result;
      });
    }
  }
}

// src/tools/search/walk.ts
import { Buffer as Buffer2 } from "node:buffer";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";

// src/tools/search/gitignore.ts
function parseGitignore(text) {
  const rules = [];
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (const rawLine of body.split(`
`)) {
    const rule = parseLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    if (rule)
      rules.push(rule);
  }
  return rules;
}
function parseLine(rawLine) {
  if (rawLine === "" || rawLine.startsWith("#"))
    return;
  let line = withoutTrailingSpaces(rawLine);
  const negated = line.startsWith("!");
  if (negated)
    line = line.slice(1);
  const folderOnly = line.endsWith("/");
  line = line.replace(/\/+$/, "");
  const anyDepth = !line.includes("/");
  line = line.replace(/^\//, "");
  if (!line)
    return;
  try {
    const regex = compilePattern(anyDepth ? segmentSource(line) : pathPatternSource(line));
    return { negated, folderOnly, anyDepth, regex };
  } catch (error) {
    if (error instanceof PatternError)
      return;
    throw error;
  }
}
function withoutTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    while (line[end - 2 - backslashes] === "\\")
      backslashes += 1;
    if (backslashes % 2 === 1)
      break;
    end -= 1;
  }
  return line.slice(0, end);
}
function isIgnored(files, path, isFolder) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  let ignored = false;
  for (const file of files) {
    const prefix = file.folder.endsWith("/") ? file.folder : `${file.folder}/`;
    if (!path.startsWith(prefix))
      continue;
    const relative = path.slice(prefix.length);
    for (const rule of file.rules) {
      if (rule.folderOnly && !isFolder)
        continue;
      if (rule.negated !== ignored)
        continue;
      if (rule.regex.test(rule.anyDepth ? name : relative))
        ignored = !rule.negated;
    }
  }
  return ignored;
}

// src/tools/search/walk.ts
class FileWalk {
  options;
  #incomplete = false;
  constructor(options) {
    this.options = options;
  }
  get incomplete() {
    return this.#incomplete;
  }
  *files() {
    yield* this.#folder(this.options.root, "", this.options.ignoreFiles);
  }
  *#folder(folder, relativeFolder, ignoreFiles) {
    if (this.#pastDeadline())
      return;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    const own = entries.some((entry) => entry.name === ".gitignore") ? readIgnoreFile(folder) : undefined;
    const applying = own ? [...ignoreFiles, own] : ignoreFiles;
    for (const entry of sortedEntries(entries)) {
      if (this.#incomplete)
        return;
      const { name } = entry;
      if (name === ".git")
        continue;
      if (!this.options.hidden && name.startsWith("."))
        continue;
      const path = childPath(folder, name);
      const relative = relativeFolder ? `${relativeFolder}/${name}` : name;
      if (entry.isDirectory()) {
        if (name === "node_modules" && !this.options.nodeModules)
          continue;
        if (this.options.skipFolders.has(path))
          continue;
        if (isIgnored(applying, path, true))
          continue;
        if (this.options.mayContain && !this.options.mayContain(relative))
          continue;
        yield* this.#folder(path, relative, applying);
        continue;
      }
      const symlink = entry.isSymbolicLink();
      if (!entry.isFile() && !(symlink && isLinkToFile(path)))
        continue;
      if (isIgnored(applying, path, false))
        continue;
      if (this.#pastDeadline())
        return;
      yield { path, relative, symlink };
    }
  }
  #pastDeadline() {
    if (Date.now() >= this.options.deadline)
      this.#incomplete = true;
    return this.#incomplete;
  }
}
var IGNORE_FILE_BYTES = 1024 * 1024;
function readIgnoreFile(folder, name = ".gitignore") {
  try {
    const path = childPath(folder, name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > IGNORE_FILE_BYTES)
      return;
    return { folder, rules: parseGitignore(readFileSync(path, "utf8")) };
  } catch {
    return;
  }
}
function sortedEntries(entries) {
  return entries.map((entry) => ({
    entry,
    key: Buffer2.from(entry.isDirectory() ? `${entry.name}/` : entry.name)
  })).sort((left, right) => Buffer2.compare(left.key, right.key)).map(({ entry }) => entry);
}
function childPath(folder, name) {
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}
function isLinkToFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// src/tools/search/search.ts
function globFiles(request, workingDirectory) {
  const scope = resolveScope(request, workingDirectory);
  const matcher = compileGlobOrFail(request.pattern, "invalid_pattern");
  if (scope.file)
    throw new SearchError("path_is_file", "The path is a file.");
  const walk = scope.walk(matcher, matcher.namesHidden);
  const files = [];
  let truncated = false;
  for (const file of walk.files()) {
    if (!matcher.matches(file.relative))
      continue;
    if (files.length === SEARCH_LIMITS.files) {
      truncated = true;
      break;
    }
    files.push(scope.display(file.path));
  }
  return { files, truncated, ...walk.incomplete ? { incomplete: true } : {} };
}
async function grepFiles(request, workingDirectory) {
  const scope = resolveScope(request, workingDirectory);
  const matcher = textMatcher(request.pattern, request.literal === true);
  const include = request.include === undefined ? undefined : compileGlobOrFail(request.include, "invalid_include");
  const walk = scope.file ? undefined : scope.walk(include, true);
  const searched = function* () {
    if (!walk) {
      yield { path: scope.target, relative: basename(scope.target), symlink: false };
      return;
    }
    for (const file of walk.files()) {
      if (include && !include.matches(file.relative))
        continue;
      if (file.symlink && !scope.holds(file.path))
        continue;
      yield file;
    }
  };
  const reads = new ReadAhead(searched(), (file) => openText(file.path, walk === undefined), (read) => !("text" in read));
  const matches = [];
  const more = {};
  let files = 0;
  let textBytes = 0;
  let textFull = false;
  let truncated = false;
  let stopped = false;
  try {
    for (let next = await reads.next();next; next = await reads.next()) {
      const { item: file, read } = next;
      if (!("text" in read)) {
        if (walk === undefined && read.skipped !== "unreadable")
          throw unsearchedError(read.skipped);
        continue;
      }
      if (!matcher.mayMatch(read.text))
        continue;
      const path = scope.display(file.path);
      let shown = 0;
      let counted = 0;
      for (const [index, line] of lines(read.text).entries()) {
        if (Date.now() >= scope.deadline) {
          stopped = true;
          break;
        }
        const match = matcher.line(line);
        if (match === undefined)
          continue;
        const text = cutLine(line, match);
        const bytes = Buffer3.byteLength(`  ${index + 1}: ${text}
`) + (shown === 0 ? Buffer3.byteLength(`${path}

`) : 0);
        if (textBytes + bytes > SEARCH_LIMITS.textBytes)
          textFull = true;
        const full = textFull || matches.length === SEARCH_LIMITS.lines;
        if (shown === 0 && full) {
          truncated = true;
          break;
        }
        if (shown > 0 && (shown === SEARCH_LIMITS.linesPerFile || full)) {
          counted += 1;
          continue;
        }
        matches.push({ path, line: index + 1, text });
        textBytes += bytes;
        shown += 1;
      }
      if (shown > 0)
        files += 1;
      if (counted > 0)
        more[path] = counted;
      if (truncated || stopped)
        break;
    }
  } finally {
    await reads.stop();
  }
  return {
    matches,
    files,
    ...Object.keys(more).length > 0 ? { more } : {},
    truncated,
    ...walk?.incomplete || stopped ? { incomplete: true } : {}
  };
}
function resolveScope(request, workingDirectory) {
  const deadline = Date.now() + request.timeoutMs;
  const working = realpathSync(workingDirectory);
  const context = request.contextDirectory === undefined ? undefined : realPath(resolve(working, request.contextDirectory));
  const target = realPath(resolve(working, request.path ?? "."));
  if (target === undefined)
    throw new SearchError("path_missing", "The path does not exist.");
  const root = context !== undefined && isWithin(target, context) ? context : isWithin(target, working) ? working : undefined;
  if (root === undefined) {
    throw new SearchError("path_outside", "The path is outside the run's folders.");
  }
  const stats = statSync2(target);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new SearchError("path_not_searchable", "The path is not a file or a folder.");
  }
  const holds = (path) => {
    const real = realPath(path);
    return real !== undefined && (isWithin(real, working) || context !== undefined && isWithin(real, context));
  };
  const display = (path) => isWithin(path, working) ? relative(working, path) || "." : path;
  const walk = (matcher, hidden) => {
    const namesNodeModules = relative(root, target).split("/").includes("node_modules");
    return new FileWalk({
      root: target,
      ignoreFiles: [...repositoryIgnoreFiles(root), ...ancestorIgnoreFiles(root, target)],
      hidden,
      nodeModules: namesNodeModules || matcher?.namesNodeModules === true,
      skipFolders: new Set(context !== undefined && !isWithin(target, context) ? [context] : []),
      ...matcher ? { mayContain: (folder) => matcher.mayContain(folder) } : {},
      deadline
    });
  };
  return { target, file: stats.isFile(), deadline, holds, display, walk };
}
var REPOSITORY_LEVELS = 20;
function repositoryIgnoreFiles(root) {
  const above = [];
  let folder = root;
  for (let level = 0;level <= REPOSITORY_LEVELS; level += 1) {
    if (holdsGit(folder)) {
      const exclude = readIgnoreFile(folder, ".git/info/exclude");
      return [
        ...exclude ? [exclude] : [],
        ...above.flatMap((parent) => readIgnoreFile(parent) ?? [])
      ];
    }
    const parent = dirname(folder);
    if (parent === folder)
      return [];
    folder = parent;
    above.unshift(folder);
  }
  return [];
}
function holdsGit(folder) {
  try {
    lstatSync2(childPath(folder, ".git"));
    return true;
  } catch {
    return false;
  }
}
function ancestorIgnoreFiles(root, target) {
  if (target === root)
    return [];
  const folders = [];
  for (let folder = dirname(target);isWithin(folder, root); folder = dirname(folder)) {
    folders.unshift(folder);
    if (folder === root)
      break;
  }
  return folders.flatMap((folder) => readIgnoreFile(folder) ?? []);
}
function compileGlobOrFail(pattern, code) {
  try {
    return compileGlob(pattern);
  } catch (error) {
    if (error instanceof PatternError)
      throw new SearchError(code, error.message);
    throw error;
  }
}
function unsearchedError(reason) {
  return reason === "binary" ? new SearchError("file_binary", "The file is binary, or not UTF-8 text.") : new SearchError("file_too_large", "The file is over 10 MiB.");
}
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return;
  }
}
function isWithin(path, root) {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

// src/tools/search/command.ts
var USAGE = "Usage: search.mjs <request JSON>";
var KEYS = {
  glob: ["tool", "pattern", "path", "contextDirectory", "timeoutMs"],
  grep: ["tool", "pattern", "path", "include", "literal", "contextDirectory", "timeoutMs"]
};
async function runSearchCommand(args, workingDirectory) {
  try {
    const request = parseRequest(args);
    const result = request.tool === "glob" ? globFiles(request, workingDirectory) : await grepFiles(request, workingDirectory);
    return { exitCode: 0, stdout: `${JSON.stringify(result)}
`, stderr: "" };
  } catch (error) {
    if (error instanceof SearchError)
      return failure(2, error.code, error.message);
    if (error instanceof RequestError)
      return failure(2, "invalid_arguments", error.message);
    const message = error instanceof Error ? error.message : "The search failed unexpectedly.";
    return failure(3, "internal_error", message);
  }
}

class RequestError extends Error {
}
function failure(exitCode, code, message) {
  return { exitCode, stdout: "", stderr: `${JSON.stringify({ error: { code, message } })}
` };
}
function fail(message) {
  throw new RequestError(message);
}
function parseRequest(args) {
  if (args.length !== 1)
    fail(USAGE);
  let value;
  try {
    value = JSON.parse(args[0]);
  } catch {
    fail("The search request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("The search request must be a JSON object.");
  }
  const input = value;
  const tool = input.tool;
  if (tool !== "glob" && tool !== "grep")
    fail("tool must be 'glob' or 'grep'.");
  for (const key of Object.keys(input)) {
    if (!KEYS[tool].includes(key))
      fail(`The ${tool} request has an unknown property '${key}'.`);
  }
  const pattern = nonEmptyString(input.pattern, "pattern");
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    fail("timeoutMs must be a non-negative integer.");
  }
  const path = optionalString(input.path, "path");
  const contextDirectory = optionalString(input.contextDirectory, "contextDirectory");
  const scope = {
    timeoutMs,
    ...path === undefined ? {} : { path },
    ...contextDirectory === undefined ? {} : { contextDirectory }
  };
  if (tool === "glob")
    return { tool, pattern, ...scope };
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    fail("literal must be true or false.");
  }
  const include = optionalString(input.include, "include");
  return {
    tool,
    pattern,
    ...scope,
    ...include === undefined ? {} : { include },
    ...input.literal === undefined ? {} : { literal: input.literal }
  };
}
function nonEmptyString(value, field) {
  if (typeof value !== "string" || value === "")
    fail(`${field} must be a non-empty string.`);
  return value;
}
function optionalString(value, field) {
  return value === undefined ? undefined : nonEmptyString(value, field);
}

// src/tools/search/main.ts
var result = await runSearchCommand(process.argv.slice(2), process.cwd());
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
