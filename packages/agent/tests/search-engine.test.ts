import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Buffer } from "node:buffer"
import * as fsPromises from "node:fs/promises"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runSearchCommand } from "../src/tools/search/command"
import { isIgnored, parseGitignore } from "../src/tools/search/gitignore"
import { compileGlob } from "../src/tools/search/glob"
import * as match from "../src/tools/search/match"
import { expandBraces } from "../src/tools/search/pattern"
import { type PendingRead, READ_AHEAD, READ_AHEAD_BYTES, ReadAhead } from "../src/tools/search/read"
import {
  type GlobSearchRequest,
  type GrepSearchRequest,
  SearchError,
} from "../src/tools/search/request"
import { globFiles, grepFiles } from "../src/tools/search/search"

const roots: string[] = []
const realOpen = fsPromises.open

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("glob patterns", () => {
  test("match a name at any depth without /, and from the start with one", () => {
    const anyDepth = compileGlob("*.md")
    expect(anyDepth.matches("README.md")).toBe(true)
    expect(anyDepth.matches("docs/guide/intro.md")).toBe(true)
    expect(anyDepth.matches("docs/intro.mdx")).toBe(false)

    const direct = compileGlob("src/*.ts")
    expect(direct.matches("src/a.ts")).toBe(true)
    expect(direct.matches("src/lib/a.ts")).toBe(false)
    expect(direct.matches("other/src/a.ts")).toBe(false)

    const deep = compileGlob("src/**/*.ts")
    expect(deep.matches("src/a.ts")).toBe(true)
    expect(deep.matches("src/lib/deep/a.ts")).toBe(true)
    expect(deep.matches("lib/a.ts")).toBe(false)

    expect(compileGlob("**/test/*.ts").matches("test/a.ts")).toBe(true)
    expect(compileGlob("**/test/*.ts").matches("pkg/test/a.ts")).toBe(true)
    expect(compileGlob("docs/**").matches("docs/a/b.md")).toBe(true)
    expect(compileGlob("./src/*.ts").matches("src/a.ts")).toBe(true)
    expect(compileGlob("/a.ts").matches("lib/a.ts")).toBe(false)
  })

  test("support ?, classes, braces and escapes", () => {
    expect(compileGlob("file?.txt").matches("file1.txt")).toBe(true)
    expect(compileGlob("file?.txt").matches("file10.txt")).toBe(false)
    expect(compileGlob("[abc].ts").matches("b.ts")).toBe(true)
    expect(compileGlob("[a-c].ts").matches("d.ts")).toBe(false)
    expect(compileGlob("[!abc].ts").matches("b.ts")).toBe(false)
    expect(compileGlob("[^abc].ts").matches("d.ts")).toBe(true)
    expect(compileGlob("[]x].ts").matches("].ts")).toBe(true)
    expect(compileGlob("*.{ts,tsx}").matches("app/view.tsx")).toBe(true)
    expect(compileGlob("*.{ts,tsx}").matches("app/view.js")).toBe(false)
    expect(compileGlob("{src,lib}/**/*.ts").matches("lib/a/b.ts")).toBe(true)
    expect(compileGlob("{src,lib}/**/*.ts").matches("test/a.ts")).toBe(false)
    expect(compileGlob("\\*.md").matches("*.md")).toBe(true)
    expect(compileGlob("\\*.md").matches("a.md")).toBe(false)
    expect(compileGlob("[unclosed").matches("[unclosed")).toBe(true)
    expect(compileGlob("{one}").matches("{one}")).toBe(true)
  })

  test("expand nested braces, and refuse a pattern with too many alternatives", () => {
    expect(expandBraces("a.{ts,{c,m}js}")).toEqual(["a.ts", "a.cjs", "a.mjs"])
    expect(expandBraces("\\{a,b}")).toEqual(["\\{a,b}"])
    expect(() => expandBraces("{a,b}".repeat(9))).toThrow("more than 256 alternatives")
  })

  test("say which folders may hold a match, and what they name", () => {
    const pattern = compileGlob("src/{app,lib}/**/*.ts")
    expect(pattern.mayContain("src")).toBe(true)
    expect(pattern.mayContain("src/app")).toBe(true)
    expect(pattern.mayContain("src/app/deep/er")).toBe(true)
    expect(pattern.mayContain("src/test")).toBe(false)
    expect(pattern.mayContain("docs")).toBe(false)
    expect(compileGlob("src/*.ts").mayContain("src/lib")).toBe(false)
    expect(compileGlob("*.ts").mayContain("anything/at/all")).toBe(true)

    expect(compileGlob("*.yml").namesHidden).toBe(false)
    expect(compileGlob(".github/**/*.yml").namesHidden).toBe(true)
    expect(compileGlob("**/.env*").namesHidden).toBe(true)
    expect(compileGlob("node_modules/react/*.json").namesNodeModules).toBe(true)
  })
})

describe(".gitignore rules", () => {
  const ignores = (text: string, path: string, isFolder = false) =>
    isIgnored([{ folder: "/repo", rules: parseGitignore(text) }], `/repo/${path}`, isFolder)

  test("skip comments and blank lines, and read escaped # and ! as themselves", () => {
    expect(parseGitignore("# a comment\n\n   \r\n")).toEqual([])
    expect(ignores("#notes.txt", "#notes.txt")).toBe(false)
    expect(ignores("\\#notes.txt", "#notes.txt")).toBe(true)
    expect(ignores("\\!important", "!important")).toBe(true)
  })

  test("drop trailing spaces unless escaped", () => {
    expect(ignores("build   ", "build")).toBe(true)
    expect(ignores("name\\ ", "name ")).toBe(true)
    expect(ignores("name\\ ", "name")).toBe(false)
  })

  test("anchor a pattern with a leading or middle /, and match a bare name at any depth", () => {
    expect(ignores("/dist", "dist", true)).toBe(true)
    expect(ignores("/dist", "packages/dist", true)).toBe(false)
    expect(ignores("docs/build", "docs/build", true)).toBe(true)
    expect(ignores("docs/build", "pkg/docs/build", true)).toBe(false)
    expect(ignores("*.log", "deep/inside/debug.log")).toBe(true)
  })

  test("match folders only with a trailing /", () => {
    expect(ignores("cache/", "cache", true)).toBe(true)
    expect(ignores("cache/", "cache", false)).toBe(false)
    expect(ignores("cache/", "a/cache", true)).toBe(true)
  })

  test("read ** forms as git does", () => {
    expect(ignores("**/logs", "logs", true)).toBe(true)
    expect(ignores("**/logs", "a/b/logs", true)).toBe(true)
    expect(ignores("logs/**", "logs/a/b.txt")).toBe(true)
    expect(ignores("logs/**", "logs", true)).toBe(false)
    expect(ignores("a/**/b", "a/b")).toBe(true)
    expect(ignores("a/**/b", "a/x/y/b")).toBe(true)
    expect(ignores("a/**/b", "c/a/b")).toBe(false)
  })

  test("let a later rule win, and bring a file back with !", () => {
    expect(ignores("*.log\n!keep.log", "keep.log")).toBe(false)
    expect(ignores("*.log\n!keep.log", "drop.log")).toBe(true)
    expect(ignores("!keep.log\n*.log", "keep.log")).toBe(true)
  })

  test("skip a line that is not a valid pattern", () => {
    expect(parseGitignore("[z-a]\n*.tmp")).toHaveLength(1)
  })

  // Reproduce: drop the byte order mark check in parseGitignore; the first rule then reads as
  // "\uFEFFdist/" and matches nothing, while git ignores dist/.
  test("drop a UTF-8 byte order mark, as git does", () => {
    expect(ignores("\uFEFFdist/\n", "dist", true)).toBe(true)
  })
})

describe("glob", () => {
  // Reproduce: sort each folder's entries by name alone in walk.ts (sortedEntries); a/b.txt then
  // comes before a-b.txt and a.txt, and a capped list is not the first paths in sorted order.
  test("lists paths in byte order", async () => {
    const root = await tempRoot({
      "a.txt": "",
      "a/b.txt": "",
      "a-b.txt": "",
      "B.txt": "",
      "é.txt": "",
    })

    expect(glob(root, "*.txt").files).toEqual(["B.txt", "a-b.txt", "a.txt", "a/b.txt", "é.txt"])
  })

  test("skips .git, hidden entries and node_modules, unless the pattern names them", async () => {
    const root = await tempRoot({
      "index.js": "",
      ".git/config.js": "",
      ".github/workflows/ci.yml": "",
      ".env.example": "",
      "node_modules/react/index.js": "",
      "packages/app/node_modules/x/index.js": "",
    })

    expect(glob(root, "*.js").files).toEqual(["index.js"])
    expect(glob(root, "*.yml").files).toEqual([])
    expect(glob(root, ".github/**/*.yml").files).toEqual([".github/workflows/ci.yml"])
    expect(glob(root, ".env*").files).toEqual([".env.example"])
    expect(glob(root, "node_modules/**/*.js").files).toEqual(["node_modules/react/index.js"])
    expect(glob(root, "*.js", "node_modules").files).toEqual(["node_modules/react/index.js"])
    expect(glob(root, "**/.git/*").files).toEqual([])
  })

  test("skips what .gitignore files exclude, each in its own folder", async () => {
    const root = await tempRoot({
      ".gitignore": "dist/\n*.log\n/local.ts\n",
      "dist/out.ts": "",
      "debug.log": "",
      "local.ts": "",
      "src/local.ts": "",
      "src/.gitignore": "generated.ts\n!keep.log\n",
      "src/generated.ts": "",
      "src/keep.log": "",
      "src/drop.log": "",
      "lib/generated.ts": "",
    })

    expect(glob(root, "*").files).toEqual(["lib/generated.ts", "src/keep.log", "src/local.ts"])
    // From a folder below, the root's .gitignore still applies.
    expect(glob(root, "*", "src").files).toEqual(["src/keep.log", "src/local.ts"])
    // A folder named as the path is searched, even when it is excluded.
    expect(glob(root, "*", "dist").files).toEqual(["dist/out.ts"])
  })

  // Reproduce: walk into folders that .gitignore excludes and filter their files instead; the
  // re-included file then shows, which git never does.
  test("never brings back a file inside an excluded folder, as git does not", async () => {
    const root = await tempRoot({
      ".gitignore": "build/\n!build/keep.txt\n",
      "build/keep.txt": "",
      "notes.txt": "",
    })

    expect(glob(root, "*.txt").files).toEqual(["notes.txt"])
  })

  // Reproduce: read the .gitignore with readFileSync alone in readIgnoreFile; the linked rules then
  // hide notes.txt, and the oversized file hides big.txt. A link to /dev/zero or a FIFO would
  // stall the search instead, which is why neither is opened.
  test("reads a .gitignore only when it is a regular file of at most 1 MiB", async () => {
    const rules = await tempRoot({ "rules.txt": "notes.txt\n" })
    const root = await tempRoot({
      "notes.txt": "",
      "big/big.txt": "",
      "big/.gitignore": `${"# padding\n".repeat(110_000)}big.txt\n`,
    })
    await symlink(join(rules, "rules.txt"), join(root, ".gitignore"))

    expect(glob(root, "*.txt").files).toEqual(["big/big.txt", "notes.txt"])
  })

  // Reproduce: return [] from repositoryIgnoreFiles in search.ts; a package of a monorepo then
  // lists the build output its repository's .gitignore excludes.
  test("applies the ignore rules of the repository above the search root", async () => {
    const repository = await tempRoot({
      ".git/info/exclude": "*.tmp\n",
      ".gitignore": "dist/\n",
      "packages/.gitignore": "*.log\n",
      "packages/app/src/a.ts": "",
      "packages/app/dist/out.ts": "",
      "packages/app/scratch.tmp": "",
      "packages/app/debug.log": "",
    })

    expect(glob(join(repository, "packages/app"), "*").files).toEqual(["src/a.ts"])
  })

  // Reproduce: take the folder above the root for a repository's top in repositoryIgnoreFiles
  // (`holdsGit(folder) || folder === dirname(root)`); the outer folder's rules then hide a.ts.
  test("applies no rule above the search root outside a repository", async () => {
    const outer = await tempRoot({ ".gitignore": "*.ts\n", "project/a.ts": "" })

    expect(glob(join(outer, "project"), "*").files).toEqual(["a.ts"])
  })

  // Reproduce: drop skipFolders from the walk in search.ts; the run's own files then show in every
  // search of the working directory.
  test("skips the run's context directory unless the search starts in it", async () => {
    const root = await tempRoot({
      "notes.md": "",
      "run/memory/MEMORY.md": "",
    })
    const contextDirectory = join(root, "run")

    expect(glob(root, "*.md", undefined, contextDirectory).files).toEqual(["notes.md"])
    expect(glob(root, "*.md", "run", contextDirectory).files).toEqual(["run/memory/MEMORY.md"])
  })

  test("follows no linked folder, and lists a linked file", async () => {
    const root = await tempRoot({ "src/a.ts": "" })
    await symlink(join(root, "src"), join(root, "linked"))
    await symlink(join(root, "src/a.ts"), join(root, "alias.ts"))

    expect(glob(root, "*.ts").files).toEqual(["alias.ts", "src/a.ts"])
  })

  test("caps the list at 100 files", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`f${String(index).padStart(3, "0")}.txt`, ""])
    )
    const root = await tempRoot(files)

    const result = glob(root, "*.txt")
    expect(result.files).toHaveLength(100)
    expect(result.files.at(-1)).toBe("f099.txt")
    expect(result.truncated).toBe(true)
    expect(glob(root, "f00*.txt").truncated).toBe(false)
  })

  // Reproduce: remove the deadline check from FileWalk; a walk past its deadline then still
  // returns everything and never says it is incomplete.
  test("stops at its deadline and says so", async () => {
    const root = await tempRoot({ "a.txt": "" })

    expect(globFiles({ tool: "glob", pattern: "*.txt", timeoutMs: 0 }, root)).toEqual({
      files: [],
      truncated: false,
      incomplete: true,
    })
  })

  // Reproduce: drop the root check in resolveScope; a path outside the run, or a link out of it,
  // is then searched.
  test("searches only inside the working directory and the context directory", async () => {
    const root = await tempRoot({ "src/a.ts": "" })
    const outside = await tempRoot({ "secret.ts": "" })
    await symlink(outside, join(root, "escape"))

    expect(await code(() => glob(root, "*", outside))).toBe("path_outside")
    expect(await code(() => glob(root, "*", "escape"))).toBe("path_outside")
    expect(await code(() => glob(root, "*", ".."))).toBe("path_outside")
    expect(await code(() => glob(root, "*", "missing"))).toBe("path_missing")
    expect(await code(() => glob(root, "*", "src/a.ts"))).toBe("path_is_file")
    expect(await code(() => glob(root, "{a,b}".repeat(9)))).toBe("invalid_pattern")

    // The context directory may sit anywhere, as a computer's does.
    expect(glob(root, "*", outside, outside).files).toEqual([join(outside, "secret.ts")])
  })

  // Reproduce: make isWithin in search.ts a plain path.startsWith(root); a folder whose name
  // extends the working directory's is then searched, and a link into it read.
  test("never reaches a sibling folder whose name starts with the working directory's", async () => {
    const parent = await tempRoot({
      "proj/inside.txt": "needle\n",
      "proj-secrets/secret.txt": "needle\n",
    })
    const root = join(parent, "proj")
    await symlink(join(parent, "proj-secrets/secret.txt"), join(root, "link.txt"))

    expect(await code(() => glob(root, "*", "../proj-secrets"))).toBe("path_outside")
    expect(
      await code(() => grep(root, { pattern: "needle", path: join(parent, "proj-secrets") }))
    ).toBe("path_outside")
    expect(paths(await grep(root, { pattern: "needle" }))).toEqual(["inside.txt"])
  })
})

describe("grep", () => {
  test("finds matching lines in every searched file, hidden ones included", async () => {
    const root = await tempRoot({
      "src/config.ts": "const retries = 3\nconst delay = 1\n  retries: 3,\n",
      ".github/ci.yml": "retries: 2\n",
      ".gitignore": "*.log\n",
      "debug.log": "retries\n",
      "node_modules/x/index.js": "retries\n",
      ".git/HEAD": "retries\n",
    })

    expect(await grep(root, { pattern: "retries" })).toEqual({
      matches: [
        { path: ".github/ci.yml", line: 1, text: "retries: 2" },
        { path: "src/config.ts", line: 1, text: "const retries = 3" },
        { path: "src/config.ts", line: 3, text: "  retries: 3," },
      ],
      files: 2,
      truncated: false,
    })
  })

  test("filters files with include, and searches a file named as the path alone", async () => {
    const root = await tempRoot({
      "src/a.ts": "needle\n",
      "src/b.tsx": "needle\n",
      "src/c.js": "needle\n",
    })

    expect(paths(await grep(root, { pattern: "needle", include: "*.{ts,tsx}" }))).toEqual([
      "src/a.ts",
      "src/b.tsx",
    ])
    // Reproduce: search the file's folder when the path is a file; b.tsx and c.js then match too.
    expect(
      paths(await grep(root, { pattern: "needle", path: "src/a.ts", include: "*.js" }))
    ).toEqual(["src/a.ts"])
  })

  test("ignores case unless the pattern has an uppercase letter", async () => {
    const root = await tempRoot({ "a.txt": "Retries\nretries\n" })

    expect(lineNumbers(await grep(root, { pattern: "retries" }))).toEqual([1, 2])
    expect(lineNumbers(await grep(root, { pattern: "Retries" }))).toEqual([1])
    // An escape such as \S is not an uppercase letter.
    expect(lineNumbers(await grep(root, { pattern: "\\Sretries" }))).toEqual([])
    expect(lineNumbers(await grep(root, { pattern: "^retries" }))).toEqual([1, 2])
  })

  // Ignoring case, \p{Lu} matches every cased letter. Reproduce: drop the property escape check
  // in lineRegex; every line then matches.
  test("keeps the case of a pattern with a property escape", async () => {
    const root = await tempRoot({ "a.txt": "abc\nAbc\n" })

    expect(lineNumbers(await grep(root, { pattern: "\\p{Lu}" }))).toEqual([2])
    expect(lineNumbers(await grep(root, { pattern: "^\\p{Lu}bc" }))).toEqual([2])
    expect(lineNumbers(await grep(root, { pattern: "^\\P{Lu}bc" }))).toEqual([1])
  })

  // Reproduce: keep the byte order mark in readText; `^using` then misses line 1.
  test("reads a file's first line past its byte order mark", async () => {
    const root = await tempRoot({ "Program.cs": "\uFEFFusing System;\nusing Linq;\n" })

    const expected = [
      { path: "Program.cs", line: 1, text: "using System;" },
      { path: "Program.cs", line: 2, text: "using Linq;" },
    ]
    expect((await grep(root, { pattern: "^using" })).matches).toEqual(expected)
    expect((await grep(root, { pattern: "^using", path: "Program.cs" })).matches).toEqual(expected)
  })

  test("searches literal text, and refuses an invalid expression", async () => {
    const root = await tempRoot({ "a.ts": "call(a, b)\ncall a\n" })

    expect(lineNumbers(await grep(root, { pattern: "call(a", literal: true }))).toEqual([1])
    expect(await code(() => grep(root, { pattern: "call(a" }))).toBe("invalid_pattern")
    expect(lineNumbers(await grep(root, { pattern: "\\p{L}+\\(", literal: false }))).toEqual([1])
  })

  // Reproduce: let one file fill the list (drop SEARCH_LIMITS.linesPerFile in grepFiles); the
  // first file's 30 lines then crowd out the others, and nothing says how many more it holds.
  test("shows at most 20 lines a file and 100 in all, counting the rest of a file", async () => {
    const many = (count: number) => "match\n".repeat(count)
    const root = await tempRoot({
      "a.txt": many(30),
      "b.txt": many(20),
      "c.txt": many(20),
      "d.txt": many(20),
      "e.txt": many(15),
      "f.txt": many(8),
      "g.txt": many(1),
    })

    const result = await grep(root, { pattern: "match" })
    expect(result.matches).toHaveLength(100)
    expect(result.files).toBe(6)
    expect(result.more).toEqual({ "a.txt": 10, "f.txt": 3 })
    expect(result.truncated).toBe(true)
  })

  test("skips binary files and files over 10 MiB, cuts long lines, and reads CRLF", async () => {
    const root = await tempRoot({
      "binary.dat": "needle\0rest",
      "long.txt": `${"x".repeat(600)} needle`,
      "windows.txt": "first\r\nneedle\r\n",
    })
    await writeFile(join(root, "huge.txt"), `needle\n${"x".repeat(10 * 1024 * 1024)}`)

    const result = await grep(root, { pattern: "needle$" })
    expect(result.matches).toEqual([
      { path: "long.txt", line: 1, text: `…${"x".repeat(492)} needle` },
      { path: "windows.txt", line: 2, text: "needle" },
    ])
  })

  // Reproduce: return `${linePrefix(line, budget)}…` for every long line in cutLine, as before;
  // the matches past the line's first 500 characters are then cut away. Start the window on
  // `start` itself, or slice it without the extra unit, and the emoji lines then split a character.
  test("shows a long line around its first match, never splitting a character", async () => {
    const root = await tempRoot({
      "min.js": `${"a".repeat(3_000)}retryCount=3${"b".repeat(3_000)}\n`,
      "start.js": `retryCount=3${"b".repeat(3_000)}\n`,
      "end.js": `${"a".repeat(3_000)}retryCount=3\n`,
      "odd.txt": `${"😀".repeat(1_000)}:retryCount${"😀".repeat(400)}\n`,
      "even.txt": `${"😀".repeat(1_000)}::retryCount${"😀".repeat(400)}\n`,
    })

    const texts = async (literal: boolean) =>
      Object.fromEntries(
        (await grep(root, { pattern: "retrycount", literal })).matches.map((found) => [
          found.path,
          found.text,
        ])
      )

    const expected = {
      "end.js": `…${"a".repeat(487)}retryCount=3`,
      "even.txt": `…${"😀".repeat(19)}::retryCount${"😀".repeat(224)}…`,
      "min.js": `…${"a".repeat(40)}retryCount=3${"b".repeat(447)}…`,
      "odd.txt": `…${"😀".repeat(19)}:retryCount${"😀".repeat(225)}…`,
      "start.js": `retryCount=3${"b".repeat(488)}…`,
    }
    expect(await texts(false)).toEqual(expected)
    expect(await texts(true)).toEqual(expected)

    for (const text of Object.values(expected)) expect(text.length).toBeLessThanOrEqual(501)
  })

  // Reproduce: test the whole line in lineMatcher (drop linePrefix); the needle past 4,000
  // characters then matches, and the minified line, whose cost grows with the cube of its length,
  // takes about a second instead of a few milliseconds.
  test("matches only the first 4,000 characters of a line", async () => {
    const root = await tempRoot({
      "a.txt": `${"x".repeat(3_990)} needle\n${"x".repeat(4_000)} needle\n`,
      "public/lib.min.js": "import a from b;".repeat(750),
      "src/app.tsx": 'import React from "react"\n',
    })

    expect(lineNumbers(await grep(root, { pattern: "needle", path: "a.txt" }))).toEqual([1])
    expect(
      lineNumbers(await grep(root, { pattern: "needle", path: "a.txt", literal: true }))
    ).toEqual([1])
    expect(await grep(root, { pattern: "import.*from.*react" })).toEqual({
      matches: [{ path: "src/app.tsx", line: 1, text: 'import React from "react"' }],
      files: 1,
      truncated: false,
    })
  })

  // Reproduce: drop the deadline check in grepFiles' loop over lines; a file named as the path
  // then has no deadline at all, and is searched to its end.
  test("stops inside a file at its deadline and says so", async () => {
    const root = await tempRoot({ "a.txt": "needle\n" })

    expect(
      await grepFiles({ tool: "grep", pattern: "needle", path: "a.txt", timeoutMs: 0 }, root)
    ).toEqual({ matches: [], files: 0, truncated: false, incomplete: true })
  })

  // Reproduce: drop the textBytes check in grepFiles; 100 lines of 500 CJK characters then make
  // about 150 KB of model text.
  test("stops adding matches once their text reaches 24 KiB", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `f${String(index).padStart(2, "0")}.txt`,
        `${"検索".repeat(300)}\n`.repeat(2),
      ])
    )
    const root = await tempRoot(files)

    const result = await grep(root, { pattern: "検索" })
    const bytes = result.matches.reduce(
      (total, match) =>
        total + Buffer.byteLength(`${match.path}\n  ${match.line}: ${match.text}\n`),
      0
    )
    expect(bytes).toBeLessThanOrEqual(24 * 1024)
    expect(result.matches.length).toBeGreaterThan(10)
    expect(result.truncated).toBe(true)
  })

  // Reproduce: skip a file named as the path as the walk skips one (drop the throw in grepFiles);
  // the search then says "No matches" about text it never read.
  test("says why a file named as the path is not searched", async () => {
    const root = await tempRoot({
      "binary.dat": "needle\0rest",
      "latin1.txt": "",
    })
    await writeFile(join(root, "utf16.txt"), Buffer.from("\uFEFFneedle", "utf16le"))
    await writeFile(join(root, "latin1.txt"), Buffer.from("caf\xe9 needle", "latin1"))
    await writeFile(join(root, "huge.txt"), `needle\n${"x".repeat(10 * 1024 * 1024)}`)

    expect(await code(() => grep(root, { pattern: "needle", path: "binary.dat" }))).toBe(
      "file_binary"
    )
    expect(await code(() => grep(root, { pattern: "needle", path: "utf16.txt" }))).toBe(
      "file_binary"
    )
    expect(await code(() => grep(root, { pattern: "needle", path: "latin1.txt" }))).toBe(
      "file_binary"
    )
    expect(await code(() => grep(root, { pattern: "needle", path: "huge.txt" }))).toBe(
      "file_too_large"
    )
    // Found by the walk, the same files are skipped, or read leniently.
    expect(paths(await grep(root, { pattern: "needle" }))).toEqual(["latin1.txt"])
  })

  // Reproduce: drop the holds() check on linked files in grepFiles; the link then leaks the
  // contents of a file outside the run's folders.
  test("never reads a linked file outside the run's folders", async () => {
    const root = await tempRoot({ "inside.txt": "needle\n" })
    const outside = await tempRoot({ "secret.txt": "needle\n" })
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"))

    expect(paths(await grep(root, { pattern: "needle" }))).toEqual(["alias.txt", "inside.txt"])
  })
})

describe("grep's whole-file test", () => {
  /** How many files grep splits into lines: those its whole-file test let through. */
  const splitFiles = async (root: string, pattern: string, literal = false) => {
    const lines = spyOn(match, "lines")
    try {
      return { result: await grep(root, { pattern, literal }), split: lines.mock.calls.length }
    } finally {
      lines.mockRestore()
    }
  }

  // Reproduce: return true from both mayMatch in match.ts; every file is then split.
  test("splits only the files that may match into lines", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`f${index}.ts`, "const delay = 1\n"])
    )
    const root = await tempRoot({ ...files, "z.ts": "const retries = 3\n" })

    for (const literal of [false, true]) {
      const { result, split } = await splitFiles(root, "retries", literal)
      expect(paths(result)).toEqual(["z.ts"])
      expect(split).toBe(1)
    }
  })

  // A pattern that can match a line break would backtrack across the whole file: `[^x]*y` takes
  // seconds on 100 KB. A lookaround could say no where the whole text says yes, and a modifier
  // group changes the flags the whole-file test relies on. Reproduce: drop readsOneLine from
  // wholeTextRegex, or any one of its checks (a lookaround or modifier group; a control character
  // or a line separator written as itself, or escaped; a range spanning U+2028); the patterns it
  // catches are then not split.
  test("searches line by line a pattern it cannot test on a whole file", async () => {
    const root = await tempRoot({ "a.ts": "const delay = 1\n", "b.ts": "let x = 2\n" })

    for (const pattern of [
      "[^x]*zz",
      "\\s*zz",
      "a\\nb",
      "\\Wzz",
      "\\Dzz",
      "[\\b-~]zz",
      "[ -\u3000]zz",
      "\\u000azz",
      "\\12zz",
      "[\t-~]zz",
      "a\\\nzz",
      "a\u2028zz",
      "a\u2029zz",
      "zz(?!bar)",
      "zz(?=bar)",
      "(?<=a)zz",
      "(?<!a)zz",
      "(?i:zz)",
      "(?-m:^)zz",
      "(?s:.)zz",
    ]) {
      expect({ pattern, split: (await splitFiles(root, pattern)).split }).toEqual({
        pattern,
        split: 2,
      })
    }
    for (const pattern of [
      "zz",
      "\\bzz\\b",
      "^zz$",
      "[a-z]+zz",
      "\\d+\\.\\w+zz",
      "[一-龥]zz",
      "(?:zz)",
      "(?<n>z)\\k<n>",
      "[(?=]zz",
    ]) {
      expect({ pattern, split: (await splitFiles(root, pattern)).split }).toEqual({
        pattern,
        split: 0,
      })
    }
  })

  // `^` and `$` hold around a lone `\r`, U+2028 and U+2029 for the whole-file test, and the lines
  // keep them inside. Reproduce: drop LONE_BREAK from linesAreWhole; these files are then not split.
  test("searches line by line a file with a lone \\r or a line separator", async () => {
    const root = await tempRoot({
      "cr.txt": "foo\rbar\n",
      "ls.txt": "foo\u2028bar\n",
      "ps.txt": "foo\u2029bar\n",
      "crlf.txt": "foo\r\nbar\r\n",
    })

    expect((await splitFiles(root, "zz")).split).toBe(3)
  })

  // Reproduce: drop the `m` flag in wholeTextRegex; `$` then holds only at the file's end, and
  // neither file matches. `$` meets `\r` in the CRLF file: with `m`, `\r` ends a line as `\n` does.
  test("finds a match at a line's end, in an LF or a CRLF file", async () => {
    const root = await tempRoot({ "lf.txt": "foo\nbar\n", "crlf.txt": "foo\r\nbar\r\n" })

    expect((await grep(root, { pattern: "foo$" })).matches).toEqual([
      { path: "crlf.txt", line: 1, text: "foo" },
      { path: "lf.txt", line: 1, text: "foo" },
    ])
  })

  // Each of these matches a line and not the whole text. Reproduce: drop the lookaround and
  // modifier check from readsOneLine; the three modifier groups are then missed. The first two
  // lines are kept by that check and by LONE_BREAK both: drop the two to see them missed.
  test("finds what a line holds, whatever the whole text reads", async () => {
    const root = await tempRoot({
      "cr.txt": "foo\rbar\n",
      "ls.txt": "foo\u2028bar\n",
      "lf.txt": "x\nfoo\n",
    })

    expect(paths(await grep(root, { pattern: "foo(?!$)" }))).toEqual(["cr.txt", "ls.txt"])
    expect(paths(await grep(root, { pattern: "(?<!^)bar" }))).toEqual(["cr.txt", "ls.txt"])
    expect(lineNumbers(await grep(root, { pattern: "(?-m:^)foo", path: "lf.txt" }))).toEqual([2])
    expect(lineNumbers(await grep(root, { pattern: "foo(?-m:$)", path: "lf.txt" }))).toEqual([2])
    expect(lineNumbers(await grep(root, { pattern: "x(?!(?s:.))", path: "lf.txt" }))).toEqual([1])
    expect(lineNumbers(await grep(root, { pattern: "foo(?!\\n)", path: "lf.txt" }))).toEqual([2])
  })

  // A line is matched over its first 4,000 characters: there, `$`, `\b` and the final Σ read the
  // cut's end, while the whole text goes on. Reproduce: drop hasLineOver from both mayMatch in
  // match.ts (linesAreWhole and the literal's); each of these files is then skipped.
  test("searches line by line a file with a line over 4,000 characters", async () => {
    const root = await tempRoot({
      "a.txt": `${" ".repeat(3_997)}foobar\n`,
      "sigma.txt": `${" ".repeat(3_998)}AΣB\n`,
    })

    expect(paths(await grep(root, { pattern: "foo$" }))).toEqual(["a.txt"])
    expect(paths(await grep(root, { pattern: "foo\\b" }))).toEqual(["a.txt"])
    expect(paths(await grep(root, { pattern: "aς", literal: true }))).toEqual(["sigma.txt"])
    // Past the cut, the whole text matches and the line does not: nothing is reported, as before.
    expect(paths(await grep(root, { pattern: "bar" }))).toEqual([])
  })
})

describe("grep's reads", () => {
  /**
   * Counts each open, close and byte read. Each file's reads wait `turns(index)` turns of the event
   * loop, its index counting opens.
   */
  const countOpens = (options: { readonly turns?: (index: number) => number } = {}) => {
    const counts = { opened: 0, closed: 0, bytesRead: 0 }
    const spy = spyOn(fsPromises, "open").mockImplementation((async (
      ...args: Parameters<typeof realOpen>
    ) => {
      const index = counts.opened
      counts.opened += 1

      const handle = await realOpen(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        counts.closed += 1
        return close()
      }

      const read = handle.read.bind(handle) as (
        ...readArgs: unknown[]
      ) => Promise<{ bytesRead: number }>
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await read(...readArgs)
        counts.bytesRead += result.bytesRead

        for (let turn = 0; turn < (options.turns?.(index) ?? 0); turn += 1) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        return result
      }) as typeof handle.read

      return handle
    }) as typeof realOpen)
    return { counts, restore: () => spy.mockRestore() }
  }

  // Reproduce: take reads in ReadAhead.next as they settle (Promise.race over the pending ones);
  // the matches then come out of order.
  test("find the same lines, in the same order, as reading one file at a time", async () => {
    const count = (index: number) => (index % 7) + 1
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `d${Math.floor(index / 10)}/f${index % 10}.txt`,
        Array.from({ length: count(index) }, (_, line) => `needle ${index}.${line}\n`).join(""),
      ])
    )
    const root = await tempRoot(files)

    // One file at a time, as the walk lists them: whole until 100 lines, then counted.
    const expected: { path: string; line: number; text: string }[] = []
    const more: Record<string, number> = {}
    for (let index = 0; index < 60 && expected.length < 100; index += 1) {
      const path = `d${Math.floor(index / 10)}/f${index % 10}.txt`
      const shown = Math.min(count(index), 100 - expected.length)
      for (let line = 0; line < shown; line += 1) {
        expected.push({ path, line: line + 1, text: `needle ${index}.${line}` })
      }
      if (shown < count(index)) more[path] = count(index) - shown
    }

    // Each file's read waits less than the one before it: they settle out of order.
    const opens = countOpens({ turns: (index) => READ_AHEAD - (index % READ_AHEAD) })
    try {
      expect(await grep(root, { pattern: "needle" })).toEqual({
        matches: expected,
        files: new Set(expected.map((found) => found.path)).size,
        more,
        truncated: true,
      })
    } finally {
      opens.restore()
    }
  })

  // Reproduce: fill ReadAhead without its READ_AHEAD bound; all 300 files are then read. Drop the
  // await in ReadAhead.stop, and files are still open when the search returns.
  test("stop reading once the search is truncated, and leave no file open", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `f${String(index).padStart(3, "0")}.txt`,
        "match\n".repeat(20),
      ])
    )
    const root = await tempRoot(files)

    // The reads past the sixth file are still in flight when the search stops.
    const opens = countOpens({ turns: (index) => (index < 6 ? 0 : 50) })
    try {
      expect((await grep(root, { pattern: "match" })).truncated).toBe(true)
      // Five files fill the list, the sixth truncates it, and the reads ahead of it.
      expect(opens.counts.opened).toBeLessThanOrEqual(6 + READ_AHEAD + 1)
      expect(opens.counts.closed).toBe(opens.counts.opened)
    } finally {
      opens.restore()
    }
  })

  // Reproduce: drop the deadline check in grepFiles' loop over lines; the files already read ahead
  // are then all searched past the deadline.
  test("stop at the deadline with the files found before it", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `f${String(index).padStart(2, "0")}.txt`,
        "needle\n",
      ])
    )
    const root = await tempRoot(files)
    const full = await grep(root, { pattern: "needle" })

    // The clock passes the deadline once 40 files have been opened.
    const opens = countOpens()
    const start = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() =>
      opens.counts.opened >= 40 ? start + 60_000 : start
    )
    try {
      const result = await grep(root, { pattern: "needle" })
      expect(result.incomplete).toBe(true)
      expect(result.matches.length).toBeLessThan(40)
      expect(result.matches).toEqual(full.matches.slice(0, result.matches.length))
    } finally {
      clock.mockRestore()
      opens.restore()
    }
  })

  // Reproduce: read the whole file before probing it for NUL in readText; the binary file is then
  // read whole.
  test("read no more of a binary file than its first bytes", async () => {
    const root = await tempRoot()
    const binary = Buffer.alloc(2 * 1024 * 1024, 0x61)
    binary[0] = 0
    await writeFile(join(root, "image.bin"), binary)

    const opens = countOpens()
    try {
      expect((await grep(root, { pattern: "a" })).matches).toEqual([])
      expect(opens.counts.bytesRead).toBeLessThanOrEqual(8 * 1024)
    } finally {
      opens.restore()
    }
  })
})

describe("reads ahead", () => {
  const MiB = 1024 * 1024

  /**
   * Takes every item, as a search does, with reads that settle a few turns after they start, and
   * reports the most bytes held at once: the reads started and not yet taken, and the file the
   * search holds, whose read the next one may start beside.
   */
  const readAll = async (
    sizes: readonly number[],
    options: {
      readonly binary?: ReadonlySet<number>
      readonly turns?: (index: number) => number
    } = {}
  ) => {
    const binary = options.binary ?? new Set<number>()
    let held = 0
    let most = 0
    /** Reads started and not yet taken, and the most of them at once. */
    let active = 0
    let mostActive = 0

    const reads = new ReadAhead(
      sizes.keys(),
      async (index: number): Promise<PendingRead<number>> => ({
        bytes: sizes[index] as number,
        async read() {
          held += sizes[index] as number
          most = Math.max(most, held)
          active += 1
          mostActive = Math.max(mostActive, active)
          for (let turn = 0; turn < (options.turns?.(index) ?? 3); turn += 1) await null
          // A binary file lets go of its bytes once it is known.
          if (binary.has(index)) held -= sizes[index] as number
          return index
        },
        close: async () => {},
      }),
      (index) => binary.has(index)
    )

    const taken: number[] = []
    for (let next = await reads.next(); next; next = await reads.next()) {
      // Each read hands back its own index.
      expect(next.read).toBe(next.item)
      taken.push(next.item)
      active -= 1
      if (!binary.has(next.item)) held -= sizes[next.item] as number
    }
    return { most, mostActive, taken }
  }

  // Reproduce: drop the bytes check in ReadAhead's #start; 40 files of 6 MiB then hold up to
  // 192 MiB at once.
  test("hold no more than READ_AHEAD_BYTES of files read ahead", async () => {
    const { most, taken } = await readAll(Array.from({ length: 40 }, () => 6 * MiB))

    expect(taken).toEqual([...Array(40).keys()])
    // Past the bound, the next file in line, and the file the search holds.
    expect(most).toBeLessThanOrEqual(READ_AHEAD_BYTES + 2 * 6 * MiB)
    // It still reads ahead: as many files of 6 MiB as fit.
    expect(most).toBeGreaterThanOrEqual(Math.floor(READ_AHEAD_BYTES / (6 * MiB)) * 6 * MiB)
  })

  // Reproduce: drop `index > 0 &&` in #start; the large file then never starts, and the search
  // takes it without a read.
  test("start the next file in line even past the bound", async () => {
    const { taken, most } = await readAll([MiB, 40 * MiB, MiB])

    expect(taken).toEqual([0, 1, 2])
    expect(most).toBeLessThanOrEqual(42 * MiB)
  })

  // Reproduce: keep a binary file's bytes held until it is taken (drop holdsNothing in #start);
  // files of 10 MiB then fill the bound, and no more are read ahead.
  test("let go of a binary file's bytes once it is known", async () => {
    // A slow first file of text, and binary files behind it, each known in a few turns.
    const sizes = [MiB, ...Array.from({ length: 40 }, () => 10 * MiB)]
    const { taken, mostActive } = await readAll(sizes, {
      binary: new Set([...sizes.keys()].slice(1)),
      turns: (index) => (index === 0 ? 200 : 3),
    })

    expect(taken).toEqual([...sizes.keys()])
    // Holding their bytes, only the first file and the binary files that fit with it would start.
    expect(mostActive).toBeGreaterThan(1 + Math.floor((READ_AHEAD_BYTES - MiB) / (10 * MiB)))
    expect(mostActive).toBeGreaterThanOrEqual(READ_AHEAD)
  })
})

describe("search.mjs", () => {
  test("takes one JSON request and prints one JSON line", async () => {
    const root = await tempRoot({ "notes.md": "needle\n" })
    const workingDirectory = await tempRoot()

    // The run's context directory may lie outside the working directory, as a computer's does.
    const request = JSON.stringify({
      tool: "grep",
      pattern: "needle",
      path: root,
      contextDirectory: root,
      timeoutMs: 20_000,
    })

    expect(await runSearchCommand([request], workingDirectory)).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({
        matches: [{ path: join(root, "notes.md"), line: 1, text: "needle" }],
        files: 1,
        truncated: false,
      })}\n`,
      stderr: "",
    })
  })

  test("refuses a request it does not understand, and names a search's failure", async () => {
    const root = await tempRoot()
    const failure = async (args: string[]) => {
      const result = await runSearchCommand(args, root)
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      return JSON.parse(result.stderr).error as { code: string; message: string }
    }
    const request = (fields: Record<string, unknown>) => [
      JSON.stringify({ tool: "glob", pattern: "*", timeoutMs: 1_000, ...fields }),
    ]

    expect(await failure([])).toEqual({
      code: "invalid_arguments",
      message: "Usage: search.mjs <request JSON>",
    })
    expect((await failure(["{"])).message).toBe("The search request is not valid JSON.")
    expect((await failure(request({ include: "*.ts" }))).message).toBe(
      "The glob request has an unknown property 'include'."
    )
    expect((await failure(request({ timeoutMs: -1 }))).message).toBe(
      "timeoutMs must be a non-negative integer."
    )
    expect(await failure(request({ path: "missing" }))).toEqual({
      code: "path_missing",
      message: "The path does not exist.",
    })
  })
})

function glob(root: string, pattern: string, path?: string, contextDirectory?: string) {
  const request: GlobSearchRequest = {
    tool: "glob",
    pattern,
    timeoutMs: 20_000,
    ...(path === undefined ? {} : { path }),
    ...(contextDirectory === undefined ? {} : { contextDirectory }),
  }
  return globFiles(request, root)
}

function grep(root: string, request: Omit<GrepSearchRequest, "tool" | "timeoutMs">) {
  return grepFiles({ tool: "grep", timeoutMs: 20_000, ...request }, root)
}

type GrepResult = Awaited<ReturnType<typeof grep>>

function paths(result: GrepResult): string[] {
  return [...new Set(result.matches.map((found) => found.path))]
}

function lineNumbers(result: GrepResult): number[] {
  return result.matches.map((found) => found.line)
}

async function code(search: () => unknown): Promise<string> {
  const error = await Promise.resolve()
    .then(search)
    .then(
      () => new Error("expected a SearchError"),
      (caught: unknown) => caught
    )
  if (error instanceof SearchError) return error.code
  throw error
}

async function tempRoot(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-search-")))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}
