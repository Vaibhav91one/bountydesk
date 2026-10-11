/** M10 Reviewer chat. Ask the agent about a case file.
 *
 * Matches docs/site/screens/m10.html: a FlatList of bubbles (me/agent), a
 * "Today" date stamp, suggestion chips under the last message, and a
 * composer with send button. Behaviour follows
 * docs/site/native-feel.html's chat section: Enter sends (unless IME
 * composing), the list scrolls to the newest bubble, and typing dots appear
 * while the agent works.
 *
 * Data: GET /reports/[id]/chat returns the thread list; POST sends
 * { clientRequestId, body } and the agent replies are polled back via GET.
 * keyboard-controller is not installed, so KeyboardAvoidingView is used for
 * composer avoidance.
 */
import {
  FlatList,
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
  ListRenderItemInfo,
} from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, useApiMutation, ApiError } from "@/lib/use-query"
import { ScreenHeader, EmptyState } from "@/components/primitives"
import { useTheme } from "@/theme"
import { useRef, useState, useEffect, useCallback } from "react"
import type { MobileCaseFile } from "@/lib/types"

/** Chat response shapes. Not in lib/types.ts (which only holds case-file types),
 *  so declared here to avoid editing shared files. */
type ChatSender = "REVIEWER" | "AGENT" | "SYSTEM"
type ChatThreadStatus = "OPEN" | "RUNNING" | "DONE" | "ERROR" | "CANCELLED"

interface ChatMessage {
  id: string
  clientRequestId: string
  sender: ChatSender
  body: string
  bodyHash: string
  modelName: string | null
  providerTurnId: string | null
  createdAt: string
}

interface ChatThread {
  id: string
  verdictId: string | null
  verdictRevision: number | null
  verdictContentHash: string | null
  status: ChatThreadStatus
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

interface ChatStatus {
  reportId: string
  threads: ChatThread[]
}

/** RFC 4122 v4 UUID generator. expo-crypto is not installed, and this module
 *  must not add deps, so a small stdlib-backed generator is used instead. */
function uuidv4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
}

/** Format a date as "Today HH:MM" or "Yesterday HH:MM" or a full date. */
function formatDayStamp(date: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  if (d.getTime() === today.getTime()) return `Today ${hh}:${mm}`
  if (d.getTime() === yesterday.getTime()) return `Yesterday ${hh}:${mm}`
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${hh}:${mm}`
}

/** The single active thread — newest messages last. */
function activeThread(status: ChatStatus | undefined): ChatThread | undefined {
  if (!status || status.threads.length === 0) return undefined
  return status.threads[status.threads.length - 1]
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors, typography, round } = useTheme()
  const [input, setInput] = useState("")
  const flatListRef = useRef<FlatList>(null)
  // Reused across send attempts for the same body so a retry (onError then a
  // retry send) keeps the same clientRequestId; the server dedupes by it.
  const pendingSendRef = useRef<{ body: string; clientRequestId: string } | null>(null)

  const { data: status, error, isError, refetch, isFetching } = useApiQuery<ChatStatus>(
    `/reports/${id}/chat`,
  )
  const { data: report } = useApiQuery<MobileCaseFile>(`/reports/${id}`)
  const mutation = useApiMutation<{ clientRequestId: string; disposition: string }, { clientRequestId: string; body: string }>(
    `/reports/${id}/chat`,
  )

  // Polling: after a POST, refetch every 2s until the agent replies or 90s pass.
  // Hooks above early returns so hook order is stable when data is undefined.
  const [isPolling, setIsPolling] = useState(false)
  const [replyFailed, setReplyFailed] = useState(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollStartRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

  const startPolling = useCallback((lastSentRequestId: string) => {
    // Clear any existing interval before creating a new one.
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    setReplyFailed(false)
    setIsPolling(true)
    pollStartRef.current = Date.now()
    const timerId = setInterval(async () => {
      const elapsed = Date.now() - pollStartRef.current
      if (elapsed > 90000) {
        clearInterval(timerId)
        pollTimerRef.current = null
        setIsPolling(false)
        return
      }
      const result = await refetch()
      const currentThread = activeThread(result.data)
      if (currentThread) {
        // ERROR and CANCELLED end a turn without an agent message (lib/reviewer-chat/queue.ts),
        // so stop waiting and say so instead of spinning until the timeout.
        if (currentThread.status === "ERROR" || currentThread.status === "CANCELLED") {
          clearInterval(timerId)
          pollTimerRef.current = null
          setIsPolling(false)
          setReplyFailed(true)
          return
        }
        const hasReply = currentThread.messages.some(
          (m) => m.sender === "AGENT" && m.clientRequestId === `${lastSentRequestId}:agent`,
        )
        if (hasReply) {
          clearInterval(timerId)
          pollTimerRef.current = null
          setIsPolling(false)
        }
      }
    }, 2000)
    pollTimerRef.current = timerId
  }, [refetch])

  const thread = activeThread(status)
  const messages = thread?.messages ?? []
  const isAgentWorking = thread && (thread.status === "OPEN" || thread.status === "RUNNING")
  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)

  // Resume polling when a thread is mid-turn on screen open. Placed above the
  // early returns so hook order stays stable regardless of auth/error state.
  // It arms only while the active thread is OPEN or RUNNING and never while a
  // poll is already running, so it cannot stack intervals.
  useEffect(() => {
    if (!thread || !isAgentWorking || pollTimerRef.current) return
    // The reply this turn owes its requester id: the clientRequestId of the
    // thread's last REVIEWER message. startPolling matches the AGENT reply by
    // `${lastSentRequestId}:agent` (lib/reviewer-chat/queue.ts).
    const lastReviewer = [...thread.messages]
      .reverse()
      .find((m) => m.sender === "REVIEWER")
    if (lastReviewer) startPolling(lastReviewer.clientRequestId)
  }, [thread, isAgentWorking, startPolling])

  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  // Meta line: report id · report title
  const reportTitle = report?.title ?? ""
  const reportId = status?.reportId ?? id ?? ""
  const meta = `${reportId} · ${reportTitle}`

  const handleSend = () => {
    const body = input.trim()
    if (!body) return
    // A retry of the same body reuses the last clientRequestId so the server
    // dedupes it (lib/reviewer-chat/queue.ts findExistingMessage). Only the
    // body, not the input value, decides equality, so edits that change the
    // body still mint a fresh id.
    let clientRequestId: string
    if (pendingSendRef.current && pendingSendRef.current.body === body) {
      clientRequestId = pendingSendRef.current.clientRequestId
    } else {
      clientRequestId = uuidv4()
      pendingSendRef.current = { body, clientRequestId }
    }
    mutation.mutate(
      { clientRequestId, body },
      {
        onSuccess: () => {
          setInput("")
          pendingSendRef.current = null
          startPolling(clientRequestId)
        },
        onError: () => {
          Alert.alert("Send failed", "Try again")
        },
      },
    )
  }

  const renderBubble = ({ item }: ListRenderItemInfo<ChatMessage>) => (
    <ChatBubble
      message={item}
      colors={colors}
      mono={typography.fontMono}
    />
  )

  const renderSeparator = () => {
    if (messages.length === 0) return null
    const lastDate = new Date(messages[messages.length - 1].createdAt)
    const dayStamp = formatDayStamp(lastDate)
    return (
      <View style={styles.dayStamp}>
        <Text style={[styles.dayText, { color: colors.muted }]}>{dayStamp}</Text>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Ask the agent" meta={meta} back backLabel="Case file" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: "padding", android: undefined })}
        keyboardVerticalOffset={Platform.select({ ios: 90, android: 0 })}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderBubble}
          contentContainerStyle={styles.chatList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          ListHeaderComponent={renderSeparator}
          ListEmptyComponent={
            <View style={styles.empty}>
              <EmptyState heading="No messages yet" body="Ask about this report to start." inline />
            </View>
          }
        />
        {replyFailed ? (
          <View style={styles.typingRow}>
            <Text style={[styles.typingText, { color: colors.red }]}>The agent could not answer. Try again.</Text>
          </View>
        ) : null}
        {!replyFailed && (isPolling || isAgentWorking || mutation.isPending) ? (
          <View style={styles.typingRow}>
            <Text style={[styles.typingDots, { color: colors.faint }]}>{"\u2022\u2022\u2022"}</Text>
            <Text style={[styles.typingText, { color: colors.muted }]}>Agent Bounty is thinking…</Text>
          </View>
        ) : null}
        <View style={styles.composerWrap}>
          <SuggestionChips
            onPress={(chip) => setInput(chip)}
            colors={colors}
            hasMessages={messages.length > 0}
            typography={typography}
          />
          <View style={[styles.composer, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
            <TextInput
              style={[styles.field, { color: colors.foreground, fontFamily: typography.fontMono }]}
              value={input}
              onChangeText={setInput}
              placeholder="Ask about this report"
              placeholderTextColor={colors.faint}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              blurOnSubmit={false}
            />
            <Pressable
              onPress={handleSend}
              disabled={!input.trim() || mutation.isPending}
              style={[styles.send, { opacity: !input.trim() || mutation.isPending ? 0.4 : 1, backgroundColor: colors.brand }]}
              accessibilityLabel="Send"
            >
              <Text style={[styles.sendIcon, { color: colors.brand }]}>{"\u2191"}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const SUGGESTION_CHIPS = ["Show the probes", "Re-check"]

function SuggestionChips({
  onPress,
  colors,
  hasMessages,
  typography,
}: {
  onPress: (text: string) => void
  colors: ReturnType<typeof useTheme>["colors"]
  hasMessages: boolean
  typography: ReturnType<typeof useTheme>["typography"]
}) {
  if (!hasMessages) return null
  return (
    <View style={styles.sugg}>
      {SUGGESTION_CHIPS.map((chip) => (
        <Pressable
          key={chip}
          onPress={() => onPress(chip)}
          style={[styles.fchip, { backgroundColor: colors.card }]}
        >
          <Text style={[styles.fchipText, { color: colors.foreground, fontFamily: typography.fontFamily }]}>{chip}</Text>
        </Pressable>
      ))}
    </View>
  )
}

interface ChatBubbleProps {
  message: ChatMessage
  colors: ReturnType<typeof useTheme>["colors"]
  mono: string
}

function ChatBubble({ message, colors, mono }: ChatBubbleProps) {
  const isMe = message.sender === "REVIEWER"
  const align = isMe ? "flex-end" : "flex-start"
  const bg = isMe ? colors.brand : colors.card
  const fg = isMe ? colors.page : colors.foreground

  return (
    <View>
      {!isMe ? <Text style={[styles.who, { color: colors.muted }]}>Agent Bounty</Text> : null}
      <View style={[styles.bubble, { alignSelf: align, backgroundColor: bg, borderColor: colors["glass-edge"] }]}>
        {message.sender === "SYSTEM" ? (
          <Text style={[styles.typingDots, { color: colors.faint }]}>
            {"\u2022\u2022\u2022"}
          </Text>
        ) : (
          <Text style={[styles.bubbleText, { color: fg, fontFamily: mono }]}>{message.body}</Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  chatList: {
    paddingTop: 12,
    paddingBottom: 16,
    gap: 8,
  },
  dayStamp: {
    alignItems: "center",
    paddingVertical: 8,
  },
  dayText: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  who: {
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(175,175,190,1)",
    paddingHorizontal: 4,
    marginBottom: 2,
  },
  bubble: {
    maxWidth: "82%",
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  typingDots: {
    fontSize: 20,
    lineHeight: 20,
    letterSpacing: -2,
  },
  typingText: {
    fontSize: 13,
    lineHeight: 18,
  },
  bubbleText: {
    fontSize: 17,
    lineHeight: 1.35 * 17,
  },
  sugg: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  fchip: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  fchipText: {
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 20,
  },
  composerWrap: {
    paddingBottom: 8,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
  },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    fontSize: 17,
    lineHeight: 1.4 * 17,
    backgroundColor: "transparent",
    outlineWidth: 0,
  },
  send: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  sendIcon: {
    fontSize: 20,
    fontWeight: "700",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    fontSize: 16,
  },
})
