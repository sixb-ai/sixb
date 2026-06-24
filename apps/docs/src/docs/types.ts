export interface DocHeading {
  readonly id: string
  readonly text: string
  readonly level: 2 | 3
}

export interface DocEntry {
  readonly title: string
  readonly section: string
  readonly sectionIndex: number
  readonly isOverview: boolean
  readonly routePath: string
  readonly markdownPath: string
  readonly summary: string
  readonly headings: readonly DocHeading[]
  readonly html: string
}
