/** M6 Reports. Searchable, filterable list of all reports. Matches
 * docs/site/screens/m6.html.
 *
 * Search filters in place as you type, and the phase filter chips narrow the
 * list client-side. A no-results state with a Clear search button appears when
 * nothing matches. Data: GET /api/mobile/v1/reports.
 */
import React, { useState, useEffect } from "react"
import { View, Text, ScrollView, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator, Share } from "react-native"
import { useRouter } from "expo-router"
import * as Clipboard from "expo-clipboard"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { api } from "@/lib/api"
import type { QueueCard } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { SvgImage } from "@/components/SvgImage"
import { TopBarPill } from "@/components/TopBarPill"
import { ReviewFab } from "@/components/ReviewFab"
import { PhasePill, LongPressMenu, ToastProvider, useToast, phaseLabel } from "@/components/primitives"
import type { PhaseKey } from "@/lib/phases"

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

/** Map internal channel names to the labels shown in the mockups. */
const CHANNEL_LABELS: Record<string, string> = {
  github: "GitHub issue",
  email: "Email",
  upload: "Upload",
  advisory: "Security advisory",
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

/** Compute a relative age label from an ISO timestamp, matching c.css ageLabel. */
function ageLabelFor(updatedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  if (hours < 24 * 7) return `${Math.floor(hours / 24)}d`
  return "Yesterday"
}

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

  const { data: firstPage, error, isError, isFetching } = useApiQuery<ReportsResponse>("/reports?limit=50")

  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)

  // Prime the first page when it arrives
  React.useEffect(() => {
    if (firstPage) {
      setPages([firstPage.reports])
      setNextOffset(firstPage.nextOffset)
      setHasMore(firstPage.nextOffset != null)
    }
  }, [firstPage])

  const loadMore = async () => {
    if (!hasMore || isFetching) return
    try {
      const more: ReportsResponse = await api<ReportsResponse>(`/reports?limit=50&offset=${nextOffset}`)
      setPages((prev) => [...prev, more.reports])
      setNextOffset(more.nextOffset)
      setHasMore(more.nextOffset != null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load more")
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

  if (!firstPage && !isError && isFetching) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} size="large" />
        <TopBarPill />
        <ReviewFab />
      </View>
    )
  }

  // Filter by search term (title, source, origin) and phase chip, in place.
  const needle = search.trim().toLowerCase()
  const filtered = allReports.filter((r) => {
    if (needle && ![r.title, r.sourceLabel, r.origin].some((f) => f?.toLowerCase().includes(needle))) {
      return false
    }
    if (activeChip !== "all" && phaseForRow(r) !== activeChip) return false
    return true
  })

  const hasFilter = needle.length > 0 || activeChip !== "all"

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Reports</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>
          {totalReports} reports
        </Text>

        {/* Search field (.search in c.css) */}
        <View style={[styles.searchContainer, { backgroundColor: colors.card, borderColor: colors["glass-edge"] }]}>
          <Icon name="search" size={20} stroke={colors.muted} />
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

        {/* Report list or no-results state */}
        {filtered.length === 0 ? (
          <View style={[styles.noResult, !hasFilter && styles.noResultNoFilter]}>
            <SvgImage name="mascot/scanning" width={150} height={150} />
            <Text style={[styles.noResultH, { color: colors.foreground }]}>
              No reports match {needle ? `"${search.trim()}"` : ""}
            </Text>
            <Text style={[styles.noResultP, { color: colors.muted }]}>
              Check the spelling, try a report id such as {firstPage?.reports[0]?.sourceLabel ?? "BD-1042"}, or remove a filter.
            </Text>
            {hasFilter ? (
              <Pressable
                onPress={() => {
                  setSearch("")
                  setActiveChip("all")
                }}
                style={({ pressed }) => [
                  styles.clearBtn,
                  { backgroundColor: colors.fill },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.clearBtnText, { color: colors.foreground }]}>Clear search</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(r) => r.id}
            renderItem={({ item, index }) => (
              <ReportRow
                row={item}
                onPress={() => router.push(`/reports/${item.id}`)}
                onLongPress={() => setLpReportId(item.id)}
                showDivider={index < filtered.length - 1}
              />
            )}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            contentContainerStyle={styles.scrollContent}
            ListFooterComponent={hasMore && !hasFilter ? <ActivityIndicator color={colors.brand} /> : null}
          />
        )}

        <Text style={[styles.note, { color: colors.muted }]}>
          Every report keeps its full history, including closed and denied ones.
        </Text>
      </ScrollView>

      <TopBarPill />
      <ReviewFab />

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

interface ReportRowProps {
  row: ReportRow
  onPress: () => void
  onLongPress: () => void
  showDivider: boolean
}

function ReportRow({ row, onPress, onLongPress, showDivider }: ReportRowProps) {
  const { colors, spacing } = useTheme()
  const phase = phaseForRow(row)
  const channelLabel = CHANNEL_LABELS[row.channel] ?? row.channel
  const subtitle = row.targetName ? `${idLabel(row)} · ${row.targetName}` : `${idLabel(row)} · ${channelLabel}`
  const timeLabel = row.investigating ? "Running" : `${ageLabelFor(row.updatedAt)} ago`

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={450}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: spacing.itemMinHeight,
          backgroundColor: colors.card,
          paddingLeft: 20,
          opacity: pressed ? 0.92 : 1,
        },
        showDivider && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
      ]}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.itemT, { color: colors.foreground }]} numberOfLines={2}>
          {row.title}
        </Text>
        <Text style={[styles.itemS, { color: colors.muted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.rowR}>
        <PhasePill phase={phase} label={pillLabel(phase)} style={styles.rowPill} />
        {row.investigating ? (
          <Text style={[styles.shimmer, { color: colors.muted }]}>Running</Text>
        ) : (
          <Text style={[styles.itemB, { color: colors.muted }]}>{timeLabel}</Text>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 16 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, marginTop: 8, marginBottom: 4 },
  hmeta: { fontSize: 15, marginBottom: 8 },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 24,
    marginBottom: 12,
  },
  searchField: {
    flex: 1,
    minWidth: 0,
    fontSize: 17,
    padding: 0,
    margin: 0,
    height: 48,
    backgroundColor: "transparent",
  },
  chipsContent: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  fchip: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  fchipText: { fontSize: 14, fontWeight: "500", lineHeight: 18 },
  list: { marginHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 18 },
  rowMain: { flex: 1, minWidth: 0 },
  itemT: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  itemS: { fontSize: 13, marginTop: 3 },
  rowR: { flexShrink: 0, flexDirection: "column", alignItems: "flex-end", gap: 6 },
  rowPill: { marginTop: 0, marginBottom: 0 },
  itemB: { fontSize: 13 },
  shimmer: { fontSize: 13 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 12, marginBottom: 60 },
  noResult: {
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 40,
  },
  noResultNoFilter: { paddingTop: 120 },
  noResultH: { fontSize: 24, fontWeight: "700", letterSpacing: -0.5, lineHeight: 29, textAlign: "center", marginTop: 18 },
  noResultP: { fontSize: 15, lineHeight: 23, textAlign: "center", maxWidth: 300, marginTop: 10 },
  clearBtn: {
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: 26,
    marginTop: 22,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
  },
  clearBtnText: { fontSize: 17, fontWeight: "600" },
})
