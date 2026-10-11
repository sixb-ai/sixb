import { StyleSheet, View } from "react-native"
import { type MarkedStyles, useMarkdown } from "react-native-marked"
import { fonts, makeStyles, type Palette, useScheme } from "../lib/theme"

function markdownStyles(c: Palette): MarkedStyles {
  const body = { fontSize: 17, lineHeight: 25, color: c.ink } as const
  return {
    text: body,
    li: body,
    paragraph: { paddingVertical: 0, marginBottom: 10 },
    strong: { fontWeight: "600" },
    link: { color: c.link },
    h1: { ...body, fontSize: 24, lineHeight: 30, fontWeight: "700", marginBottom: 8 },
    h2: { ...body, fontSize: 20, lineHeight: 26, fontWeight: "700", marginBottom: 6 },
    h3: { ...body, fontSize: 18, lineHeight: 24, fontWeight: "600", marginBottom: 4 },
    codespan: { fontFamily: fonts.mono, fontSize: 15, backgroundColor: c.well },
    code: { backgroundColor: c.well, borderRadius: 12, padding: 12, marginBottom: 10 },
    codeText: { fontFamily: fonts.mono, fontSize: 14, lineHeight: 20, color: c.ink },
    blockquote: { borderLeftColor: c.rule, marginBottom: 10 },
    hr: { backgroundColor: c.rule, marginVertical: 12 },
    table: { borderColor: c.rule, marginBottom: 10 },
  }
}

const useMarkdownOptions = makeStyles((c) => ({
  styles: markdownStyles(c),
  theme: { colors: { text: c.ink, link: c.link, code: c.well, border: c.rule } },
}))

/** An assistant reply's markdown, re-rendered as more of it streams in. */
export function MarkdownText({ value }: { readonly value: string }) {
  const scheme = useScheme()
  const options = useMarkdownOptions()
  const elements = useMarkdown(value, { colorScheme: scheme, ...options })
  return <View style={styles.root}>{elements}</View>
}

const styles = StyleSheet.create({
  root: { marginBottom: -10 },
})
