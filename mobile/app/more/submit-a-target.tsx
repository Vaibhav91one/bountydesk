/** M28 Submit a target. Reviewer upload of a target for building.
 *
 * Matches docs/site/screens/m28.html exactly:
 * - Top bar with a round glass back button (back to Connections / M14).
 * - H1 "Submit a target", meta "Upload target material and the settings to run it".
 * - Section "Source": a segmented control (Tarball / Dockerfile / Image).
 *   Tarball and Dockerfile show a "Choose a file" button that opens the system
 *   document picker (expo-document-picker). Image shows text inputs for the
 *   image reference and digest.
 * - Section "Report": an empty textarea for the reviewer's description.
 * - Section "How the target runs": KvRows for Port, Readiness path and Start
 *   command, shown as editable inputs with the mockup defaults.
 * - Footer bar with a "Build and bind target" button that posts to
 *   POST /api/mobile/v1/integrations/upload.
 *
 * The upload route is documented in docs/mobile-api.md: a multipart form with
 * title, body, contact, port, readinessPath, startCommand, ecosystem. The
 * reviewer's session is the contact proof, so no OTP round trip.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable } from "react-native"
import { useRouter } from "expo-router"
import * as DocumentPicker from "expo-document-picker"

import { api, ApiError } from "@/lib/api"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { PrimaryButton, ScreenHeader, ToastProvider, useToast, ScreenTitle } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, KvLine, Note } from "@/components/CaseUi"
import { font } from "@/lib/fonts"

type SourceKind = "tar" | "dockerfile" | "image"

export default function SubmitTargetScreen() {
  return (
    <ToastProvider>
      <SubmitTargetInner />
    </ToastProvider>
  )
}

function SubmitTargetInner() {
  const { colors } = useTheme()
  const toast = useToast()
  const [source, setSource] = useState<SourceKind>("tar")
  const [imageRef, setImageRef] = useState("")
  const [digest, setDigest] = useState("")
  const [report, setReport] = useState("")
  const [port, setPort] = useState("3000")
  const [readinessPath, setReadinessPath] = useState("/")
  const [startCommand, setStartCommand] = useState("")
  const [pickedFile, setPickedFile] = useState<{ uri: string; name: string } | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const router = useRouter()

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: false,
    })
    if (!result.canceled && result.assets && result.assets[0]) {
      setPickedFile({ uri: result.assets[0].uri, name: result.assets[0].name })
    }
  }

  const handleBuild = async () => {
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const form = new FormData()
      form.append("title", "Reviewer upload")
      form.append("body", report)
      form.append("port", port)
      form.append("readinessPath", readinessPath)
      form.append("startCommand", startCommand)

      if (source === "image") {
        form.append("imageRef", imageRef)
        form.append("imageDigest", digest)
      } else if (source === "tar" || source === "dockerfile") {
        if (!pickedFile) {
          setSubmitError("Choose a file first")
          setIsSubmitting(false)
          return
        }
        // Pass the file uri as-is so we never read the whole file into JS memory.
        // The field name matches parseUploadForm in lib/upload/intake.ts.
        const fieldName = source === "tar" ? "archive" : "dockerfile"
        // @ts-expect-error — FormData on React Native accepts { uri, name, type }
        form.append(fieldName, {
          uri: pickedFile.uri,
          name: pickedFile.name,
          type: "application/octet-stream",
        })
      }

      const result = await api<{ reportId: string }>("/integrations/upload", {
        method: "POST",
        body: form,
      })
      toast.show(`Report submitted: ${result.reportId}`)
      setIsSubmitting(false)
      router.push("/more/connections")
    } catch (e) {
      if (e instanceof ApiError) {
        setSubmitError(e.message)
      } else {
        setSubmitError(e instanceof Error ? e.message : "Upload failed")
      }
      setIsSubmitting(false)
    }
  }

  const filePicker = (title: string, subtitle: string) => (
    <View style={styles.panel}>
      <ListCard>
        <Pressable onPress={handlePickFile} style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]} accessibilityLabel={title}>
          <ItemLine
            title={pickedFile?.name ?? title}
            subtitle={subtitle}
            leading={
              <View style={[styles.avatar, { backgroundColor: colors.brand + "38" }]}>
                <Icon name="upload" size={20} stroke={colors["brand-soft"]} />
              </View>
            }
          />
        </Pressable>
      </ListCard>
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Connections" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ScreenTitle title="Submit a target" meta="Upload target material and the settings to run it" metaBottom={24} />

        <View style={styles.sect}>
          <SectionHead title="Source" />
          <View style={styles.segWrap}>
            <View style={[styles.seg, { backgroundColor: colors.raised }]}>
              <SegButton label="Tarball" selected={source === "tar"} onPress={() => setSource("tar")} />
              <SegButton label="Dockerfile" selected={source === "dockerfile"} onPress={() => setSource("dockerfile")} />
              <SegButton label="Image" selected={source === "image"} onPress={() => setSource("image")} />
            </View>
          </View>

          {source === "tar" && filePicker("Choose a file", ".tar or .tgz, Dockerfile at its root")}
          {source === "dockerfile" && filePicker("Choose a Dockerfile", "A single file, built in the sandbox")}

          {source === "image" && (
            <View style={styles.imageInputs}>
              <Text style={[styles.lbl, { color: colors.muted }]}>Image</Text>
              <TextInput
                value={imageRef}
                onChangeText={setImageRef}
                placeholder="docker.io/owner/image"
                placeholderTextColor={colors.faint}
                style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={[styles.lbl, { color: colors.muted }]}>Digest</Text>
              <TextInput
                value={digest}
                onChangeText={setDigest}
                placeholder="sha256:"
                placeholderTextColor={colors.faint}
                style={[styles.field, styles.fieldMono, { backgroundColor: colors.raised, color: colors.foreground }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={[styles.imageNote, { color: colors.muted }]}>Pinned by digest. Docker Hub and GHCR unless the operator allows others.</Text>
            </View>
          )}
        </View>

        <View style={styles.sect}>
          <SectionHead title="Report" />
          <View style={styles.segWrap}>
            <TextInput
              value={report}
              onChangeText={setReport}
              multiline
              placeholder="Describe the target and what it should run"
              placeholderTextColor={colors.faint}
              accessibilityLabel="Report"
              style={[styles.field, styles.area, { backgroundColor: colors.raised, color: colors.foreground }]}
              textAlignVertical="top"
            />
          </View>
        </View>

        <View style={styles.sect}>
          <SectionHead title="How the target runs" />
          <ListCard>
            <KvLine label="Port" trailing={<RunInput value={port} onChange={setPort} placeholder="Port" numeric />} />
            <KvLine label="Readiness path" trailing={<RunInput value={readinessPath} onChange={setReadinessPath} placeholder="Readiness path" mono />} divider />
            <KvLine label="Start command" trailing={<RunInput value={startCommand} onChange={setStartCommand} placeholder="npm start" mono />} divider />
          </ListCard>
          <Note>The build runs in a sandbox. The drafted verdict still needs your approval before anything is delivered.</Note>
          {submitError ? <Text style={[styles.error, { color: colors.red }]}>{submitError}</Text> : null}
        </View>
      </ScrollView>

      <BottomFade />
      <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
        <PrimaryButton
          title={isSubmitting ? "Building…" : "Build and bind target"}
          onPress={handleBuild}
          disabled={isSubmitting}
          style={styles.btn}
        />
      </View>
    </View>
  )
}

/** c.css .seg button: 44 high, 15px, the selected one on the selection fill. */
function SegButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={[styles.segBtn, { backgroundColor: selected ? colors.selection : "transparent" }]}
    >
      <Text style={[styles.segBtnText, { color: selected ? colors.foreground : colors.muted, fontFamily: selected ? font.semibold : font.medium }]}>{label}</Text>
    </Pressable>
  )
}

/** The value side of a "How the target runs" row: an input that reads like the design's muted value text. */
function RunInput({ value, onChange, placeholder, mono, numeric }: { value: string; onChange: (v: string) => void; placeholder: string; mono?: boolean; numeric?: boolean }) {
  const { colors } = useTheme()
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      style={[styles.runInput, mono && styles.runInputMono, { color: colors.muted }]}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={numeric ? "numeric" : "default"}
    />
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
  segWrap: { paddingHorizontal: 16 },
  panel: { paddingTop: 12 },
  seg: { flexDirection: "row", borderRadius: 24, padding: 2, gap: 2 },
  segBtn: { flex: 1, minHeight: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  segBtnText: { fontSize: 15, lineHeight: 15 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  imageInputs: { paddingHorizontal: 16 },
  lbl: { fontFamily: font.semibold, fontSize: 15, lineHeight: 15, paddingTop: 20, paddingBottom: 10, paddingHorizontal: 4 },
  field: { minHeight: 52, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, fontFamily: font.regular, fontSize: 17, lineHeight: 23.8 },
  fieldMono: { fontFamily: font.mono, fontSize: 15 },
  area: { height: 92, minHeight: 92 },
  imageNote: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingTop: 10, paddingLeft: 4 },
  runInput: { flex: 1, padding: 0, marginTop: -1.5, fontFamily: font.regular, fontSize: 17, lineHeight: 22.95, letterSpacing: -0.187, textAlign: "right" },
  runInputMono: { fontFamily: font.mono, fontSize: 14, lineHeight: 21, letterSpacing: 0 },
  error: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingTop: 10, paddingHorizontal: 20 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, flexDirection: "row", gap: 6, padding: 6, borderRadius: 36, borderWidth: 1 },
  btn: { flex: 1 },
})
