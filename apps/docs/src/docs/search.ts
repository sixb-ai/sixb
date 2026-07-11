import type { DocHeading } from "./types"

export interface SearchableDoc {
  readonly title: string
  readonly section: string
  readonly routePath: string
  readonly summary: string
  readonly headings: readonly DocHeading[]
}

interface SearchField {
  readonly text: string
  readonly words: readonly string[]
  readonly exactWordScore: number
  readonly prefixWordScore: number
  readonly containsScore: number
}

export function searchDocs<T extends SearchableDoc>(docs: readonly T[], rawQuery: string): T[] {
  const phrase = normalizeSearchText(rawQuery)
  const tokens = unique(tokenize(phrase))
  if (tokens.length === 0) return []

  return docs
    .map((doc, index) => ({ doc, index, score: scoreDoc(doc, phrase, tokens) }))
    .filter((result) => result.score !== null)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.index - right.index)
    .map((result) => result.doc)
}

function scoreDoc(doc: SearchableDoc, phrase: string, tokens: readonly string[]): number | null {
  const title = normalizeSearchText(doc.title)
  const section = normalizeSearchText(doc.section)
  const route = normalizeSearchText(doc.routePath)
  const headings = normalizeSearchText(doc.headings.map((heading) => heading.text).join(" "))
  const summary = normalizeSearchText(doc.summary)

  let score = phraseScore(title, phrase, 2_000, 1_500, 1_200)
  score += phraseScore(section, phrase, 900, 650, 450)
  score += phraseScore(route, phrase, 700, 500, 350)
  score += phraseScore(headings, phrase, 300, 220, 160)
  score += phraseScore(summary, phrase, 100, 75, 50)

  const fields: readonly SearchField[] = [
    field(title, 260, 210, 150),
    field(route, 190, 150, 110),
    field(section, 170, 135, 95),
    field(headings, 110, 85, 60),
    field(summary, 35, 25, 15),
  ]

  for (const token of tokens) {
    const tokenScore = Math.max(...fields.map((searchField) => scoreToken(searchField, token)))
    if (tokenScore === 0) return null
    score += tokenScore
  }

  return score
}

function field(
  text: string,
  exactWordScore: number,
  prefixWordScore: number,
  containsScore: number
): SearchField {
  return {
    text,
    words: tokenize(text),
    exactWordScore,
    prefixWordScore,
    containsScore,
  }
}

function phraseScore(
  text: string,
  phrase: string,
  exactScore: number,
  prefixScore: number,
  containsScore: number
): number {
  if (text === phrase) return exactScore
  if (text.startsWith(phrase)) return prefixScore
  if (text.includes(phrase)) return containsScore
  return 0
}

function scoreToken(searchField: SearchField, token: string): number {
  const stem = stemWord(token)

  if (searchField.words.some((word) => word === token || stemWord(word) === stem)) {
    return searchField.exactWordScore
  }

  if (
    searchField.words.some((word) => {
      const wordStem = stemWord(word)
      return word.startsWith(token) || wordStem.startsWith(stem)
    })
  ) {
    return searchField.prefixWordScore
  }

  if (token.length >= 3 && searchField.text.includes(token)) {
    return searchField.containsScore
  }

  return 0
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokenize(value: string): string[] {
  return value.split(" ").filter(Boolean)
}

function stemWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
