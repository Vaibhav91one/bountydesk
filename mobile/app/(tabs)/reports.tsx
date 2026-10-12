/** M6 Reports. Searchable, filterable list of all reports. Matches
 * docs/site/screens/m6.html.
 *
 * Search filters in place as you type, and the phase filter chips narrow the
 * list client-side. A no-results state with a Clear search button appears when
 * nothing matches. Data: GET /api/mobile/v1/reports.
 */
import React, { useState, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator, Share } from "react-native"
import { useRouter } from "expo-router"
import * as Clipboard from "expo-clipboard"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { api } from "@/lib/api"
import type { QueueCard } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { SvgImage } from "@/components/SvgImage"
import { TopBarPill } from "@/components/TopBarPill"
import { ScreenTitle, LongPressMenu, ToastProvider, useToast, phaseLabel } from "@/components/primitives"
import type { PhaseKey } from "@/lib/phases"
import { ListCard, ReportRow } from "@/components/ReportList"
import { ageText } from "@/lib/age"
import { font } from "@/lib/fonts"

/** Reports list response from GET /reports. */
interface ReportsResponse {
  reports: ReportRow[]
  total: number
  nextOffset: number | null
}

interface ReportRow extends QueueCard {
  origin: string
}

/** Display a report id using sourceLabel per the mockup. */
function idLabel(row: ReportRow): string {
  return row.sourceLabel ?? row.id
}

/** Map report state to the PhaseKey used by PhasePill and chip filter. */
const STATE_TO_PHASE: Record<string, PhaseKey> = {
  TRIAGING: "triaging",
  NEEDS_DECISION: "triaging",
  REPRODUCING: "reproducing",
  ANALYSIS_ONLY: "analysis",
  AWAITING_APPROVAL: "approval",
  DELIVERING: "delivered",
  DELIVERED: "delivered",
  DENIED: "closed",
  OUT_OF_SCOPE: "closed",
  CANCELLED: "closed",
  EXPIRED: "closed",
}

function phaseForRow(row: ReportRow): PhaseKey {
  return STATE_TO_PHASE[row.state] ?? "closed"
}

/** The pill label for a phase in report rows. The mockup uses "Approval" (not
 * "Awaiting approval") inside list rows. */
function pillLabel(phase: PhaseKey): string {
  if (phase === "approval") return "Approval"
  return phaseLabel(phase)
}

/** Phase chips shown in m6.html, in order: All, Approval, Reproducing, Analysis, Triaging, Delivered, Closed. */
const PHASE_CHIPS: { value: PhaseKey; label: string }[] = [
  { value: "approval", label: "Approval" },
  { value: "reproducing", label: "Reproducing" },
  { value: "analysis", label: "Analysis" },
  { value: "triaging", label: "Triaging" },
  { value: "delivered", label: "Delivered" },
  { value: "closed", label: "Closed" },
]

function ReportsScreenContent() {
  const { colors } = useTheme()
  const router = useRouter()
  const toast = useToast()
  const [search, setSearch] = useState("")
  const [activeChip, setActiveChip] = useState<PhaseKey | "all">("all")
  const [lpReportId, setLpReportId] = useState<string | null>(null)
  const [pages, setPages] = useState<ReportRow[][]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Search runs on the server (GET /reports?q= matches the whole index), debounced so each
  // keystroke does not fire a request. The loaded pages belong to one query path.
  const [debouncedSearch, setDebouncedSearch] = useState("")
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  const qs = debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : ""
  const path = `/reports?limit=50${qs}`
  const [pagesFor, setPagesFor] = useState<string | null>(null)
  const { data: firstPage, error, isError, isFetching } = useApiQuery<ReportsResponse>(path)

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)

  // Prime pages once per query path: a background refetch of the same path must not drop pages
  // loaded by loadMore, and a new search starts from its own first page.
  React.useEffect(() => {
    if (firstPage && pagesFor !== path) {
      setPages([firstPage.reports])
      setNextOffset(firstPage.nextOffset)
      setHasMore(firstPage.nextOffset != null)
      setLoadError(null)
      setPagesFor(path)
    }
  }, [firstPage, path, pagesFor])

  // onEndReached can fire again before state flushes, so a ref guards the in-flight request.
  // pathRef drops a page that arrives after the search changed, so it never lands in new results.
  const loadingMoreRef = React.useRef(false)
  const pathRef = React.useRef(path)
  pathRef.current = path
  const loadMore = async () => {
    if (!hasMore || isFetching || loadingMoreRef.current || nextOffset == null) return
    loadingMoreRef.current = true
    const forPath = path
    try {
      const more: ReportsResponse = await api<ReportsResponse>(`/reports?limit=50&offset=${nextOffset}${qs}`)
      if (pathRef.current !== forPath) return
      setPages((prev) => [...prev, more.reports])
      setNextOffset(more.nextOffset)
      setHasMore(more.nextOffset != null)
    } catch (e) {
      if (pathRef.current !== forPath) return
      setLoadError(e instanceof Error ? e.message : "Failed to load more")
    } finally {
      loadingMoreRef.current = false
    }
  }


  const allReports = pages.flat()
  const totalReports = firstPage?.total ?? allReports.length

  if (error && !isAuthError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{(error as Error).message}</Text>
      </View>
    )
  }

  // The full-screen spinner is for the very first load only. A new search keeps the list (and the
  // focused search field) mounted and shows the previous results until its own page arrives.
  if (pagesFor === null && !firstPage && !isError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} size="large" />
        <TopBarPill />
      </View>
    )
  }

  // Search is server-side; the phase chip filters the loaded rows.
  const needle = search.trim().toLowerCase()
  const filtered = allReports.filter((r) => {
    if (activeChip !== "all" && phaseForRow(r) !== activeChip) return false
    return true
  })

  const hasFilter = needle.length > 0 || activeChip !== "all"
  // The server total already reflects the search; a phase chip filters loaded rows on the client, so
  // its count is the rows shown, marked "+" while more pages remain unloaded.
  const shownCount = activeChip === "all" ? String(totalReports) : `${filtered.length}${hasMore ? "+" : ""}`

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        testID="reports-list"
        onScroll={({ nativeEvent: e }) => {
          if (e.contentOffset.y + e.layoutMeasurement.height > e.contentSize.height - 600) loadMore()
        }}
        scrollEventThrottle={100}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
            <ScreenTitle title="Reports" meta={`${shownCount} reports`} metaBottom={16} />

            {/* Search field (.search in c.css) */}
            <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
              <Icon name="search" size={22} stroke={colors.muted} />
              <TextInput
                style={[styles.searchField, { color: colors.foreground }]}
                placeholder="Search reports"
                placeholderTextColor={colors.faint}
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>

            {/* Filter chips (.fchips in c.css) */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipsContent}
            >
              <Pressable
                onPress={() => setActiveChip("all")}
                style={({ pressed }) => [
                  styles.fchip,
                  { backgroundColor: activeChip === "all" ? colors.foreground : colors.card },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.fchipText, { color: activeChip === "all" ? colors.background : colors.foreground }]}>
                  All
                </Text>
              </Pressable>
              {PHASE_CHIPS.map((chip) => {
                const selected = activeChip === chip.value
                return (
                  <Pressable
                    key={chip.value}
                    testID={`chip-${chip.value}`}
                    onPress={() => setActiveChip(selected ? "all" : chip.value)}
                    style={({ pressed }) => [
                      styles.fchip,
                      { backgroundColor: selected ? colors.foreground : colors.card },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text style={[styles.fchipText, { color: selected ? colors.background : colors.foreground }]}>
                      {chip.label}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>

        <View style={styles.listSection}>
          {filtered.length > 0 ? (
            <ListCard>
              {filtered.map((item, index) => (
                <ReportRowItem
                  key={item.id}
                  row={item}
                  onPress={() => router.push(`/reports/${item.id}`)}
                  onLongPress={() => setLpReportId(item.id)}
                  showDivider={index > 0}
                />
              ))}
            </ListCard>
          ) : (
            <View style={[styles.noResult, !hasFilter && styles.noResultNoFilter]}>
              <SvgImage name="mascot/scanning" width={150} height={150} />
              <Text style={[styles.noResultH, { color: colors.foreground }]}>
                No reports match {needle ? `"${search.trim()}"` : ""}
              </Text>
              <Text style={[styles.noResultP, { color: colors.muted }]}>
                Check the spelling, try a report id, or remove a filter.
              </Text>
              {hasFilter ? (
                <Pressable
                  onPress={() => {
                    setSearch("")
                    setActiveChip("all")
                  }}
                  style={({ pressed }) => [styles.clearBtn, { backgroundColor: colors.fill }, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.clearBtnText, { color: colors.foreground }]}>Clear search</Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {loadError ? (
            <Pressable onPress={() => { setLoadError(null); loadMore() }} style={styles.loadError}>
              <Text style={[styles.loadErrorText, { color: colors.red }]}>Could not load more. Tap to retry</Text>
            </Pressable>
          ) : null}
          {!loadError && hasMore && !hasFilter ? <ActivityIndicator color={colors.brand} /> : null}
          <Text style={[styles.note, { color: colors.muted }]}>
            Every report keeps its full history, including closed and denied ones.
          </Text>
        </View>
      </ScrollView>
      <TopBarPill />

      {lpReportId && (() => {
        const card = allReports.find((r) => r.id === lpReportId)
        const copyLabel = idLabel(card ?? { id: lpReportId, sourceLabel: lpReportId } as ReportRow)
        return (
          <LongPressMenu
            reportId={copyLabel}
            visible={true}
            onClose={() => setLpReportId(null)}
            onOpenCaseFile={() => {
              setLpReportId(null)
              router.push(`/reports/${lpReportId}`)
            }}
            onCopyId={async () => {
              setLpReportId(null)
              await Clipboard.setStringAsync(copyLabel)
              toast.show("Copied " + copyLabel)
            }}
            onShare={async () => {
              setLpReportId(null)
              await Share.share({ message: `${copyLabel} ${card?.title ?? ""}` })
            }}
          />
        )
      })()}
    </View>
  )
}

export default function ReportsScreen() {
  return (
    <ToastProvider>
      <ReportsScreenContent />
    </ToastProvider>
  )
}

interface ReportRowItemProps {
  row: ReportRow
  onPress: () => void
  onLongPress: () => void
  showDivider: boolean
}

function ReportRowItem({ row, onPress, onLongPress, showDivider }: ReportRowItemProps) {
  const phase = phaseForRow(row)
  const subtitle = row.targetName ? `${idLabel(row)} · ${row.targetName}` : `${idLabel(row)} · ${row.channel}`
  return (
    <ReportRow
      title={row.title}
      subtitle={subtitle}
      phase={phase}
      pillLabel={pillLabel(phase)}
      age={ageText(row.updatedAt, true)}
      running={row.investigating}
      divider={showDivider}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: font.regular, fontSize: 16 },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 24,
  },
  searchField: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.regular, fontSize: 17,
    padding: 0,
    margin: 0,
    height: 48,
    backgroundColor: "transparent",
  },
  chipsContent: { gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  fchip: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  fchipText: { fontFamily: font.medium, fontSize: 15, lineHeight: 15, top: 1 },
  listSection: { marginTop: 20 },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingHorizontal: 20, paddingTop: 10 },
  noResult: {
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 40,
  },
  noResultNoFilter: { paddingTop: 120 },
  noResultH: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.5, lineHeight: 29, textAlign: "center", marginTop: 18 },
  noResultP: { fontFamily: font.regular, fontSize: 15, lineHeight: 23, textAlign: "center", maxWidth: 300, marginTop: 10 },
  clearBtn: {
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: 26,
    marginTop: 22,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
  },
  clearBtnText: { fontFamily: font.semibold, fontSize: 17, },
  loadError: {
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  loadErrorText: {
    fontFamily: font.medium, fontSize: 15,
    
  },
})
