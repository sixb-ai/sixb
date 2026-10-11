import { listAgentThreads } from "@sixb/client"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect, useMemo, useState } from "react"
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Glass, GlassButton } from "../../components/Glass"
import { ChevronLeftIcon, CloseIcon, SearchIcon } from "../../components/icons"
import { chatTitle } from "../../lib/agent/titles"
import type { AgentThreadSummary } from "../../lib/agent/types"
import { type HistorySection, historySections, historyTime, lastActivity } from "../../lib/history"
import { makeStyles, usePalette, useScheme } from "../../lib/theme"
import { useConnectedWorkspace } from "../../lib/workspace-context"

const PAGE_SIZE = 50
// Past this scroll offset the large title has gone under the bar, which then shows it small.
const TITLE_SCROLL_OFFSET = 44

/** Every conversation, newest first, grouped by when it last moved and searchable by title. */
export default function HistoryScreen() {
  const styles = useStyles()
  const c = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { client } = useConnectedWorkspace()
  const [search, setSearch] = useState("")
  const [titleInBar, setTitleInBar] = useState(false)

  const threads = useInfiniteQuery({
    queryKey: ["threads", "history"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await listAgentThreads({
          client,
          query: {
            status: "active",
            order: "desc",
            limit: String(PAGE_SIZE),
            offset: String(pageParam),
          },
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE_SIZE : undefined),
  })

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = threads
  const searching = search.trim().length > 0
  // Search covers every chat, so load the rest while a search is open.
  useEffect(() => {
    if (searching && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [searching, hasNextPage, isFetchingNextPage, fetchNextPage])

  const sections = useMemo(
    () => historySections(threads.data?.pages.flatMap((page) => page.threads) ?? [], search),
    [threads.data, search]
  )

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const past = event.nativeEvent.contentOffset.y > TITLE_SCROLL_OFFSET
    if (past !== titleInBar) setTitleInBar(past)
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar style="auto" />
      <View style={[styles.bar, titleInBar && styles.barScrolled]}>
        <GlassButton
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        >
          <View style={styles.chevron}>
            <ChevronLeftIcon color={c.ink} />
          </View>
        </GlassButton>
        <Text style={[styles.barTitle, !titleInBar && styles.hidden]} aria-hidden={!titleInBar}>
          Chats
        </Text>
        <View style={styles.barSpacer} />
      </View>

      <SectionList
        sections={sections as HistorySection[]}
        keyExtractor={(thread) => thread.id}
        stickySectionHeadersEnabled={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={32}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            tintColor={c.muted}
            refreshing={threads.isRefetching && !isFetchingNextPage}
            onRefresh={() => void threads.refetch()}
          />
        }
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        ListHeaderComponent={
          <View>
            <Text style={styles.largeTitle} accessibilityRole="header">
              Chats
            </Text>
            <SearchField value={search} onChange={setSearch} />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item, index, section }) => (
          <ThreadRow
            thread={item}
            first={index === 0}
            last={index === section.data.length - 1}
            onPress={() =>
              router.push({ pathname: "/chat/[threadId]", params: { threadId: item.id } })
            }
          />
        )}
        ListEmptyComponent={
          threads.isPending ? (
            <ActivityIndicator style={styles.status} color={c.muted} />
          ) : threads.isError ? (
            <View style={styles.status}>
              <Text style={styles.statusText}>Couldn't load your chats.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void threads.refetch()}
                style={styles.retry}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={[styles.status, styles.statusText]}>
              {searching ? `No chats match “${search.trim()}”.` : "No chats yet."}
            </Text>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? <ActivityIndicator style={styles.more} color={c.muted} /> : null
        }
      />
    </View>
  )
}

function SearchField({
  value,
  onChange,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const scheme = useScheme()
  const styles = useStyles()
  const c = usePalette()
  return (
    <Glass style={styles.search}>
      <SearchIcon color={c.muted} />
      <TextInput
        accessibilityLabel="Search chats"
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder="Search"
        placeholderTextColor={c.muted}
        autoCorrect={false}
        returnKeyType="search"
        keyboardAppearance={scheme}
        clearButtonMode="never"
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange("")}
          hitSlop={8}
          style={styles.clear}
        >
          <CloseIcon color={c.onInverse} size={10} />
        </Pressable>
      ) : null}
    </Glass>
  )
}

function ThreadRow({
  thread,
  first,
  last,
  onPress,
}: {
  readonly thread: AgentThreadSummary
  readonly first: boolean
  readonly last: boolean
  readonly onPress: () => void
}) {
  const styles = useStyles()
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        first && styles.rowFirst,
        last && styles.rowLast,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.rowBody, !last && styles.rowDivider]}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {chatTitle(thread)}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {thread.activeRunId ? "Replying now" : historyTime(lastActivity(thread))} · {count}
        </Text>
      </View>
    </Pressable>
  )
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: 52,
      paddingTop: 4,
      paddingBottom: 4,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: "transparent",
    },
    barScrolled: { borderBottomColor: c.rule },
    // The chevron's point sits left of its box; nudge it so it reads centered in the circle.
    chevron: { marginLeft: -2 },
    barSpacer: { width: 40 },
    barTitle: { fontSize: 17, fontWeight: "600", color: c.ink },
    hidden: { opacity: 0 },
    content: { paddingHorizontal: 16 },
    largeTitle: {
      marginTop: 2,
      paddingHorizontal: 4,
      fontSize: 34,
      lineHeight: 41,
      fontWeight: "700",
      letterSpacing: -0.6,
      color: c.ink,
    },
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      height: 40,
      marginTop: 12,
      paddingHorizontal: 14,
      borderRadius: 20,
    },
    searchInput: { flex: 1, height: 40, fontSize: 17, color: c.ink },
    clear: {
      width: 18,
      height: 18,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.faint,
    },
    sectionTitle: {
      marginTop: 26,
      marginBottom: 8,
      paddingHorizontal: 4,
      fontSize: 15,
      fontWeight: "600",
      color: c.muted,
    },
    row: { paddingLeft: 16, backgroundColor: c.card },
    rowFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
    rowLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
    rowPressed: { backgroundColor: c.well },
    rowBody: { gap: 2, paddingVertical: 12, paddingRight: 16 },
    rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.rule },
    rowTitle: { fontSize: 17, fontWeight: "600", color: c.ink },
    rowDetail: { fontSize: 15, color: c.muted },
    status: { marginTop: 40, alignItems: "center" },
    statusText: { fontSize: 15, color: c.muted, textAlign: "center" },
    retry: { marginTop: 4, height: 44, justifyContent: "center" },
    retryText: { fontSize: 15, fontWeight: "600", color: c.link },
    more: { marginVertical: 20 },
  })
)
