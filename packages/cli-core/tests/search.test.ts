import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { search } from "../src/commands/search"
import { CliError } from "../src/output"
import { isIgnored, parseGitignore } from "../src/search/gitignore"
import { compileGlob } from "../src/search/glob"
import { expandBraces } from "../src/search/pattern"
import {
  type GlobSearchRequest,
  type GrepSearchRequest,
  globFiles,
  grepFiles,
  SearchError,
} from "../src/search/search"

const roots: string[] = []

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

    expect(code(() => glob(root, "*", outside))).toBe("path_outside")
    expect(code(() => glob(root, "*", "escape"))).toBe("path_outside")
    expect(code(() => glob(root, "*", ".."))).toBe("path_outside")
    expect(code(() => glob(root, "*", "missing"))).toBe("path_missing")
    expect(code(() => glob(root, "*", "src/a.ts"))).toBe("path_is_file")
    expect(code(() => glob(root, "{a,b}".repeat(9)))).toBe("invalid_pattern")

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

    expect(code(() => glob(root, "*", "../proj-secrets"))).toBe("path_outside")
    expect(code(() => grep(root, { pattern: "needle", path: join(parent, "proj-secrets") }))).toBe(
      "path_outside"
    )
    expect(paths(grep(root, { pattern: "needle" }))).toEqual(["inside.txt"])
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

    expect(grep(root, { pattern: "retries" })).toEqual({
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

    expect(paths(grep(root, { pattern: "needle", include: "*.{ts,tsx}" }))).toEqual([
      "src/a.ts",
      "src/b.tsx",
    ])
    // Reproduce: search the file's folder when the path is a file; b.tsx and c.js then match too.
    expect(paths(grep(root, { pattern: "needle", path: "src/a.ts", include: "*.js" }))).toEqual([
      "src/a.ts",
    ])
  })

  test("ignores case unless the pattern has an uppercase letter", async () => {
    const root = await tempRoot({ "a.txt": "Retries\nretries\n" })

    expect(lineNumbers(grep(root, { pattern: "retries" }))).toEqual([1, 2])
    expect(lineNumbers(grep(root, { pattern: "Retries" }))).toEqual([1])
    // An escape such as \S is not an uppercase letter.
    expect(lineNumbers(grep(root, { pattern: "\\Sretries" }))).toEqual([])
    expect(lineNumbers(grep(root, { pattern: "^retries" }))).toEqual([1, 2])
  })

  test("searches literal text, and refuses an invalid expression", async () => {
    const root = await tempRoot({ "a.ts": "call(a, b)\ncall a\n" })

    expect(lineNumbers(grep(root, { pattern: "call(a", literal: true }))).toEqual([1])
    expect(code(() => grep(root, { pattern: "call(a" }))).toBe("invalid_pattern")
    expect(lineNumbers(grep(root, { pattern: "\\p{L}+\\(", literal: false }))).toEqual([1])
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

    const result = grep(root, { pattern: "match" })
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

    const result = grep(root, { pattern: "needle$" })
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

    const texts = (literal: boolean) =>
      Object.fromEntries(
        grep(root, { pattern: "retrycount", literal }).matches.map((match) => [
          match.path,
          match.text,
        ])
      )

    const expected = {
      "end.js": `…${"a".repeat(487)}retryCount=3`,
      "even.txt": `…${"😀".repeat(19)}::retryCount${"😀".repeat(224)}…`,
      "min.js": `…${"a".repeat(40)}retryCount=3${"b".repeat(447)}…`,
      "odd.txt": `…${"😀".repeat(19)}:retryCount${"😀".repeat(225)}…`,
      "start.js": `retryCount=3${"b".repeat(488)}…`,
    }
    expect(texts(false)).toEqual(expected)
    expect(texts(true)).toEqual(expected)

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

    expect(lineNumbers(grep(root, { pattern: "needle", path: "a.txt" }))).toEqual([1])
    expect(lineNumbers(grep(root, { pattern: "needle", path: "a.txt", literal: true }))).toEqual([
      1,
    ])
    expect(grep(root, { pattern: "import.*from.*react" })).toEqual({
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
      grepFiles({ tool: "grep", pattern: "needle", path: "a.txt", timeoutMs: 0 }, root)
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

    const result = grep(root, { pattern: "検索" })
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

    expect(code(() => grep(root, { pattern: "needle", path: "binary.dat" }))).toBe("file_binary")
    expect(code(() => grep(root, { pattern: "needle", path: "utf16.txt" }))).toBe("file_binary")
    expect(code(() => grep(root, { pattern: "needle", path: "latin1.txt" }))).toBe("file_binary")
    expect(code(() => grep(root, { pattern: "needle", path: "huge.txt" }))).toBe("file_too_large")
    // Found by the walk, the same files are skipped, or read leniently.
    expect(paths(grep(root, { pattern: "needle" }))).toEqual(["latin1.txt"])
  })

  // Reproduce: drop the holds() check on linked files in grepFiles; the link then leaks the
  // contents of a file outside the run's folders.
  test("never reads a linked file outside the run's folders", async () => {
    const root = await tempRoot({ "inside.txt": "needle\n" })
    const outside = await tempRoot({ "secret.txt": "needle\n" })
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"))

    expect(paths(grep(root, { pattern: "needle" }))).toEqual(["alias.txt", "inside.txt"])
  })
})

describe("sixb search", () => {
  test("takes one JSON request and prints one JSON line", async () => {
    const root = await tempRoot({ "notes.md": "needle\n" })
    const written: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      // The run's context directory may lie outside the working directory, as a computer's does.
      search([
        JSON.stringify({
          tool: "grep",
          pattern: "needle",
          path: root,
          contextDirectory: root,
          timeoutMs: 20_000,
        }),
      ])
    } finally {
      stdout.mockRestore()
    }

    expect(written).toEqual([
      `${JSON.stringify({
        matches: [{ path: join(root, "notes.md"), line: 1, text: "needle" }],
        files: 1,
        truncated: false,
      })}\n`,
    ])
  })

  test("refuses a request it does not understand, and names a search's failure", async () => {
    const root = await tempRoot()
    const failure = (args: string[]) => {
      try {
        search(args)
      } catch (error) {
        if (error instanceof CliError) return error.body
        throw error
      }
      throw new Error("expected a CliError")
    }
    const request = (fields: Record<string, unknown>) => [
      JSON.stringify({ tool: "glob", pattern: "*", timeoutMs: 1_000, ...fields }),
    ]

    expect(failure(["{"]).message).toBe("The search request is not valid JSON.")
    expect(failure(request({ include: "*.ts" })).message).toBe(
      "The glob request has an unknown property 'include'."
    )
    expect(failure(request({ timeoutMs: -1 })).message).toBe(
      "timeoutMs must be a non-negative integer."
    )
    expect(failure(request({ path: join(root, "missing"), contextDirectory: root })).code).toBe(
      "path_missing"
    )
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

function paths(result: ReturnType<typeof grep>): string[] {
  return [...new Set(result.matches.map((match) => match.path))]
}

function lineNumbers(result: ReturnType<typeof grep>): number[] {
  return result.matches.map((match) => match.line)
}

function code(search: () => unknown): string {
  try {
    search()
  } catch (error) {
    if (error instanceof SearchError) return error.code
    throw error
  }
  throw new Error("expected a SearchError")
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
