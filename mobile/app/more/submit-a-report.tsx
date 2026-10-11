/** M20 Submit a report. Public upload form.
 * Matches docs/site/screens/m20.html exactly.
 *
 * Form: Title, Report (multi-line), Your email, Target material picker (sheet
 * with radios: None, Tarball, Dockerfile, Prebuilt image). Submit sends a
 * multipart form to POST /api/intake/upload, then navigates to M21 (contact verify)
 * passing the report id and contact email as params.
 *
 * The upload route is public (no auth), so this screen calls fetch directly rather
 * than useApiMutation, which prefixes the mobile API base path. The route returns
 * { reportId, codeSent } with status 202.
 */
import { readError } from "@/lib/api"
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, Card, Sheet, useToast } from "@/components/primitives"
import { Icon } from "@/components/icons"
import { ApiError } from "@/lib/use-query"

const TARGET_MATERIALS: { value: string; label: string; subtitle: string }[] = [
  { value: "none", label: "None", subtitle: "Describe the issue in the report only" },
  { value: "tarball", label: "Tarball", subtitle: "Source archive of the application" },
  { value: "dockerfile", label: "Dockerfile", subtitle: "A single file that builds the target" },
  { value: "prebuilt", label: "Prebuilt image", subtitle: "An image pinned by digest" },
]

export default function SubmitReportScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { show } = useToast()

  const [title, setTitle] = useState("")
  const [report, setReport] = useState("")
  const [email, setEmail] = useState("")
  const [material, setMaterial] = useState("none")
  const [sheetVisible, setSheetVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pickedFile, setPickedFile] = useState<{ uri: string; name: string; mimeType: string } | null>(null)
  const [imageRef, setImageRef] = useState("")
  const [imageDigest, setImageDigest] = useState("")

  const handlePickFile = () => {
    // Lazy-load expo-document-picker so this module does not import a native
    // dependency at module-evaluation time (keeps route-scanning tests green).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DocumentPicker = require("expo-document-picker")
    DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: false,
    }).then((result: { canceled: boolean; assets?: { uri: string; name: string; mimeType?: string }[] }) => {
      if (!result.canceled && result.assets && result.assets[0]) {
        const asset = result.assets[0]
        setPickedFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/octet-stream" })
      }
    })
  }

  const handleSubmit = async () => {
    try {
      setSubmitting(true)
      // Build a multipart form to POST /api/intake/upload.
      const formData = new FormData()
      formData.append("title", title)
      formData.append("body", report)
      formData.append("contact", email)

      if (material === "tarball" && pickedFile) {
        // @ts-expect-error — FormData on React Native accepts { uri, name, type }
        formData.append("archive", {
          uri: pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType,
        })
      } else if (material === "dockerfile" && pickedFile) {
        // @ts-expect-error — FormData on React Native accepts { uri, name, type }
        formData.append("dockerfile", {
          uri: pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType,
        })
      } else if (material === "prebuilt") {
        formData.append("imageRef", imageRef)
        formData.append("imageDigest", imageDigest)
      }

      const baseURL = process.env.EXPO_PUBLIC_API_BASE
      const response = await fetch(`${baseURL}/api/intake/upload`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        let msg: string
        msg = (await readError(response)).message ?? `Upload failed (${response.status})`
        throw new Error(msg)
      }

      const result = await response.json().catch(() => ({}))
      if (result.ok === false) {
        throw new Error(result.error || "Submit failed")
      }

      // Navigate to contact verify (M21) with the report id and email.
      router.push({
        pathname: "/more/submit-a-report/contact-verify",
        params: { reportId: result.reportId, email },
      })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      show(msg.slice(0, 200))
    } finally {
      setSubmitting(false)
    }
  }

  const materialComplete = () => {
    if (material === "none") return true
    if (material === "tarball" || material === "dockerfile") return pickedFile !== null
    if (material === "prebuilt") return imageRef.trim() !== "" && imageDigest.trim() !== ""
    return true
  }

  const selectedMaterial = TARGET_MATERIALS.find((m) => m.value === material) || TARGET_MATERIALS[0]

  // Subtitle for the main "Add target material" card row.
  // Shows the file name (tarball/dockerfile), the image ref (prebuilt), or "None selected".
  const materialSubtitle = (() => {
    if (material === "tarball" || material === "dockerfile") {
      return pickedFile ? pickedFile.name : "None selected"
    }
    if (material === "prebuilt") {
      if (imageRef.trim()) {
        return imageRef
      }
      return "None selected"
    }
    return "None selected"
  })()

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Submit a report" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Submit a report</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Goes to the reviewer team. No account needed.</Text>

        <View style={styles.form}>
          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Title</Text>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="Short summary"
              placeholderTextColor={colors.faint}
              value={title}
              onChangeText={setTitle}
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Report</Text>
            <TextInput
              style={[styles.field, styles.textarea, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="What happened and how to reproduce it"
              placeholderTextColor={colors.faint}
              value={report}
              onChangeText={setReport}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Your email</Text>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="you@company.com"
              placeholderTextColor={colors.faint}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              textContentType="username"
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Target material</Text>
            <Card style={styles.list}>
              <Pressable
                onPress={() => setSheetVisible(true)}
                style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
              >
                <View style={styles.rowLeading}>
                  <Icon name="upload" size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>Add target material</Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>
                    {materialSubtitle}
                  </Text>
                </View>
                <View style={styles.rowTrailing}>
                  <Icon name="chev" size={18} stroke={colors.faint} />
                </View>
              </Pressable>
            </Card>
          </View>

          {(material === "tarball" || material === "dockerfile") && (
            <View style={styles.pickerRow}>
              <Pressable
                onPress={handlePickFile}
                style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
              >
                <View style={styles.rowLeading}>
                  <Icon name="upload" size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>
                    {material === "tarball" ? "Choose archive" : "Choose Dockerfile"}
                  </Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>
                    {pickedFile ? pickedFile.name : "Tap to choose"}
                  </Text>
                </View>
              </Pressable>
            </View>
          )}

          {material === "prebuilt" && (
            <View style={styles.prebuiltInputs}>
              <View>
                <Text style={[styles.lbl, { color: colors.muted }]}>Image reference</Text>
                <TextInput
                  style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
                  placeholder="ghcr.io/owner/image:tag"
                  placeholderTextColor={colors.faint}
                  value={imageRef}
                  onChangeText={setImageRef}
                  autoCapitalize="none"
                />
              </View>
              <View>
                <Text style={[styles.lbl, { color: colors.muted }]}>Digest</Text>
                <TextInput
                  style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
                  placeholder="sha256:"
                  placeholderTextColor={colors.faint}
                  value={imageDigest}
                  onChangeText={setImageDigest}
                  autoCapitalize="none"
                />
              </View>
            </View>
          )}
        </View>

        <Text style={[styles.note, { color: colors.muted }]}>
          We email a one-time code to confirm you sent this report. Replies only go to a verified address.
        </Text>

        {/* Target material sheet */}
        <Sheet
          visible={sheetVisible}
          onClose={() => setSheetVisible(false)}
          onConfirm={() => setSheetVisible(false)}
          title="Target material"
          subtitle="Optional. Reviewers build it in an isolated sandbox."
        >
          <View style={styles.sheetContent}>
            {TARGET_MATERIALS.map((m) => (
              <Pressable
                key={m.value}
                onPress={() => {
                  setMaterial(m.value)
                  setPickedFile(null)
                  setSheetVisible(false)
                }}
                style={[styles.sheetItem, { backgroundColor: colors.card }]}
              >
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>{m.label}</Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>{m.subtitle}</Text>
                </View>
                <View style={styles.rowTrailing}>
                  <View
                    style={[
                      styles.radio,
                      material === m.value && { backgroundColor: colors.brand, borderColor: colors.brand },
                    ]}
                  >
                    {material === m.value && <View style={[styles.radioDot, { backgroundColor: colors.brand }]} />}
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        </Sheet>
      </ScrollView>

      {/* Floating submit bar */}
      <View style={[styles.fbar, { backgroundColor: colors.background }]}>
        <Pressable
          onPress={handleSubmit}
          disabled={submitting || !title || !report || !email || !materialComplete()}
          style={({ pressed }) => [
            styles.fbarBtn,
            { backgroundColor: colors.brand },
            (submitting || !title || !report || !email || !materialComplete()) && { opacity: 0.4 },
            pressed && !submitting && { opacity: 0.92 },
          ]}
        >
          <Text style={[styles.fbarBtnText, { color: colors.foreground }]}>Submit report</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 80,
  },
  h1: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  form: {
    gap: 16,
  },
  lbl: {
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  field: {
    minHeight: 52,
    borderRadius: 20,
    paddingHorizontal: 16,
    fontSize: 17,
    lineHeight: 23,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  textarea: {
    height: 132,
    minHeight: 132,
    paddingTop: 14,
    paddingBottom: 14,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    padding: 0,
    marginTop: 4,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeading: {
    paddingLeft: 0,
    paddingRight: 12,
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
  },
  itemS: {
    fontSize: 13,
    marginTop: 3,
  },
  rowTrailing: {
    paddingLeft: 12,
    paddingRight: 0,
  },
  pickerRow: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    marginBottom: 4,
  },
  sheetContent: {
    paddingBottom: 8,
  },
  sheetItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 64,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  radio: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "rgba(0,0,0,0.3)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  radioDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 12,
  },
  fbar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 88,
    flexDirection: "row",
    gap: 6,
    padding: 6,
    borderRadius: 36,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fbarBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  fbarBtnText: {
    fontSize: 17,
    fontWeight: "600",
  },
  prebuiltInputs: {
    gap: 16,
    paddingHorizontal: 16,
  },
})