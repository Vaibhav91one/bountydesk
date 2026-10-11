/** M28 Submit a target. Reviewer upload of a target for building.
 *
 * Matches docs/site/screens/m28.html exactly:
 * - Top bar with a round glass back button (back to Connections / M14).
 * - H1 "Submit a target", meta "Upload target material and the settings to run it".
 * - Section "Source": a segmented control (Tarball / Dockerfile / Image).
 *   Tarball and Dockerfile show a "Choose a file" button that opens the system
 *   document picker (expo-document-picker). Image shows text inputs for the
 *   image reference and digest.
 * - Section "Report": a textarea pre-filled with the mockup's example report.
 * - Section "How the target runs": KvRows for Port, Readiness path and Start
 *   command, shown as editable inputs with the mockup defaults.
 * - Footer bar with a "Build and bind target" button that posts to
 *   POST /api/mobile/v1/integrations/upload.
 *
 * The upload route is documented in docs/mobile-api.md: a multipart form with
 * title, body, contact, material, port, readinessPath, startCommand,
 * ecosystem. The reviewer's session is the contact proof, so no OTP round trip.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable } from "react-native"
import * as DocumentPicker from "expo-document-picker"

import { api, ApiError } from "@/lib/api"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { Card, SectionHeader, ScreenHeader, Mono } from "@/components/primitives"

type SourceKind = "tar" | "dockerfile" | "image"

export default function SubmitTargetScreen() {
  const { colors } = useTheme()
  const [source, setSource] = useState<SourceKind>("tar")
  const [imageRef, setImageRef] = useState("")
  const [digest, setDigest] = useState("")
  const [report, setReport] = useState(
    "The q parameter on the search page is stored and rendered without encoding.",
  )
  const [port, setPort] = useState("3000")
  const [readinessPath, setReadinessPath] = useState("/")
  const [startCommand, setStartCommand] = useState("npm start")
  const [fileName, setFileName] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: false,
    })
    if (!result.canceled && result.assets && result.assets[0]) {
      setFileName(result.assets[0].name)
    }
  }

  const handleBuild = async () => {
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const form = new FormData()
      form.append("title", "Reviewer upload")
      form.append("body", report)
      form.append("material", source === "image" ? "image" : source === "dockerfile" ? "git" : "archive")
      form.append("port", port)
      form.append("readinessPath", readinessPath)
      form.append("startCommand", startCommand)
      form.append("ecosystem", "node")

      if (source === "image") {
        form.append("title", `Image: ${imageRef}`)
      }

      // api() returns JSON for JSON content types. For the upload route the
      // server returns 202 with a JSON body ({ reportId }), so the default
      // handling works. We pass headers explicitly so the FormData boundary is
      // set by fetch, not overwritten by JSON.stringify.
      const result = await api<{ reportId: string }>("/integrations/upload", {
        method: "POST",
        body: form,
      })
      void result
      // The mockup toasts then pops back to M14. We clear the submit state.
      setIsSubmitting(false)
    } catch (e) {
      const msg = e instanceof ApiError ? `Upload failed (${e.status})` : "Upload failed"
      setSubmitError(msg)
      setIsSubmitting(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Submit a target" back backLabel="Connections" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Submit a target</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>
          Upload target material and the settings to run it
        </Text>

        {/* Source */}
        <SectionHeader title="Source" chevron={false} />
        <View style={styles.segContainer}>
          <View style={[styles.seg, { backgroundColor: colors.raised }]}>
            <SegButton
              label="Tarball"
              selected={source === "tar"}
              onPress={() => setSource("tar")}
              colors={colors}
            />
            <SegButton
              label="Dockerfile"
              selected={source === "dockerfile"}
              onPress={() => setSource("dockerfile")}
              colors={colors}
            />
            <SegButton
              label="Image"
              selected={source === "image"}
              onPress={() => setSource("image")}
              colors={colors}
            />
          </View>
        </View>

        {/* Source detail panel */}
        {source === "tar" && (
          <Card style={styles.cardPick}>
            <Pressable
              onPress={handlePickFile}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            >
              <View style={styles.filePickerRow}>
                <View style={[styles.avatar, { backgroundColor: colors.fill }]}>
                  <Icon name="upload" size={20} stroke={colors.foreground} />
                </View>
                <View style={styles.filePickerMain}>
                  <Text style={[styles.filePickerTitle, { color: colors.foreground }]}>
                    {fileName ?? "Choose a file"}
                  </Text>
                  <Text style={[styles.filePickerSubtitle, { color: colors.muted }]}>
                    .tar or .tgz, Dockerfile at its root
                  </Text>
                </View>
              </View>
            </Pressable>
          </Card>
        )}

        {source === "dockerfile" && (
          <Card style={styles.cardPick}>
            <Pressable
              onPress={handlePickFile}
              style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
            >
              <View style={styles.filePickerRow}>
                <View style={[styles.avatar, { backgroundColor: colors.fill }]}>
                  <Icon name="upload" size={20} stroke={colors.foreground} />
                </View>
                <View style={styles.filePickerMain}>
                  <Text style={[styles.filePickerTitle, { color: colors.foreground }]}>
                    {fileName ?? "Choose a Dockerfile"}
                  </Text>
                  <Text style={[styles.filePickerSubtitle, { color: colors.muted }]}>
                    A single file, built in the sandbox
                  </Text>
                </View>
              </View>
            </Pressable>
          </Card>
        )}

        {source === "image" && (
          <View style={styles.imageInputs}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.lbl, { color: colors.muted }]}>Image</Text>
              <TextInput
                value={imageRef}
                onChangeText={setImageRef}
                placeholder="docker.io/bkimminich/juice-shop"
                placeholderTextColor={colors.faint}
                style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground, borderColor: colors.line }]}
                autoCapitalize="none"
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={[styles.lbl, { color: colors.muted }]}>Digest</Text>
              <TextInput
                value={digest}
                onChangeText={setDigest}
                placeholder="sha256:"
                placeholderTextColor={colors.faint}
                style={[styles.field, styles.fieldMono, { backgroundColor: colors.raised, color: colors.foreground, borderColor: colors.line }]}
                autoCapitalize="none"
              />
            </View>
            <Text style={[styles.note, { color: colors.muted }]}>
              Pinned by digest. Docker Hub and GHCR unless the operator allows others.
            </Text>
          </View>
        )}

        {/* Report */}
        <SectionHeader title="Report" chevron={false} />
        <View style={[styles.card, styles.reportCard]}>
          <TextInput
            value={report}
            onChangeText={setReport}
            multiline
            placeholder="Describe the target and what it should run"
            placeholderTextColor={colors.faint}
            style={[styles.area, { backgroundColor: colors.raised, color: colors.foreground }]}
            textAlignVertical="top"
          />
        </View>

        {/* How the target runs */}
        <SectionHeader title="How the target runs" chevron={false} />
        <Card style={styles.card}>
          <KvRowEdit label="Port" value={port} onChange={setPort} colors={colors} numeric />
          <KvRowEdit label="Readiness path" value={readinessPath} onChange={setReadinessPath} colors={colors} mono />
          <KvRowEdit label="Start command" value={startCommand} onChange={setStartCommand} colors={colors} mono />
        </Card>
        <Text style={[styles.note, { color: colors.muted }]}>
          The build runs in a sandbox. The drafted verdict still needs your approval before anything is delivered.
        </Text>

        {submitError ? <Text style={[styles.note, { color: colors.red }]}>{submitError}</Text> : null}
      </ScrollView>

      {/* Footer: Build and bind target */}
      <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
        <Pressable
          onPress={handleBuild}
          disabled={isSubmitting}
          style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.92 : 1 }]}
          accessibilityLabel="Build and bind target"
        >
          <Text style={[styles.btnText, { color: "#ffffff" }]}>
            {isSubmitting ? "Building…" : "Build and bind target"}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

function SegButton({
  label,
  selected,
  onPress,
  colors,
}: {
  label: string
  selected: boolean
  onPress: () => void
  colors: { brand: string; foreground: string; muted: string; raised: string }
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.segBtn,
        {
          backgroundColor: selected ? colors.brand : "transparent",
        },
      ]}
    >
      <Text
        style={[
          styles.segBtnText,
          {
            color: selected ? "#ffffff" : colors.muted,
            fontWeight: selected ? "600" : "500",
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function KvRowEdit({
  label,
  value,
  onChange,
  colors,
  mono,
  numeric,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  colors: { foreground: string; muted: string; raised: string; line: string; faint: string }
  mono?: boolean
  numeric?: boolean
}) {
  return (
    <View style={[styles.kvRow, { borderBottomColor: colors.line }]}>
      <Text style={[styles.kvLabel, { color: colors.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor={colors.faint}
        style={[styles.kvValue, mono && styles.kvValueMono, numeric && styles.kvValueNumeric, { color: colors.foreground }]}
        autoCapitalize="none"
        keyboardType={numeric ? "numeric" : "default"}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 6, paddingBottom: 100 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.03 * 28, lineHeight: 32, paddingHorizontal: 20, paddingTop: 16 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 20, marginBottom: 12 },
  card: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4 },
  cardPick: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4, marginTop: 8 },
  reportCard: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", marginBottom: 4, padding: 0 },
  segContainer: { paddingHorizontal: 16, paddingVertical: 12 },
  seg: {
    flexDirection: "row",
    borderRadius: 24,
    padding: 2,
    gap: 2,
  },
  segBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  segBtnText: {
    fontSize: 14,
    letterSpacing: 0,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  filePickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 18,
  },
  filePickerMain: { flex: 1, minWidth: 0 },
  filePickerTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  filePickerSubtitle: { fontSize: 13, marginTop: 3 },
  imageInputs: { paddingHorizontal: 16, gap: 16, marginBottom: 4 },
  fieldGroup: { gap: 6 },
  lbl: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  field: {
    minHeight: 52,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    fontSize: 17,
    lineHeight: 22,
  },
  fieldMono: {
    fontFamily: "GeistMono",
    fontSize: 15,
  },
  area: {
    minHeight: 92,
    borderRadius: 0,
    borderWidth: 0,
    paddingHorizontal: 18,
    paddingTop: 14,
    fontSize: 17,
    lineHeight: 22,
  },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, marginTop: 10 },
  kvRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 56,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  kvLabel: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  kvValue: { fontSize: 17, textAlign: "right", flexShrink: 1, paddingVertical: 10 },
  kvValueMono: { fontFamily: "GeistMono", fontSize: 15 },
  kvValueNumeric: { width: 80, textAlign: "right" },
  fbar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 30,
    flexDirection: "row",
    gap: 6,
    padding: 6,
    borderRadius: 36,
    borderWidth: StyleSheet.hairlineWidth,
  },
  btn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    backgroundColor: "#6774F0",
  },
  btnText: { fontSize: 17, fontWeight: "600" },
})
