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
} from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useApiQuery, useApiMutation, ApiError } from "@/lib/use-query"
import { ScreenHeader, EmptyState } from "@/components/primitives"
import { useTheme } from "@/theme"
import { useRef, useState } from "react"

/** Chat response shapes. Not in lib/types.ts (which only holds case-file types),
 *  so declared here to avoid editing shared files. */
type ChatSender = "REVIEWER" | "AGENT" | "SYSTEM"

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
  status: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

interface ChatStatus {
  reportId: string
  threads: ChatThread[]
}

/** The single active thread — newest messages last. */
function useActiveThread(status: ChatStatus | undefined): ChatThread | undefined {
  if (!status || status.threads.length === 0) return undefined
  return status.threads[status.threads.length - 1]
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors, typography } = useTheme()
  const [input, setInput] = useState("")
  const flatListRef = useRef<FlatList>(null)

  const { data: status, error, isError, refetch } = useApiQuery<ChatStatus>(`/reports/${id}/chat`)
  const mutation = useApiMutation<{ clientRequestId: string }, { clientRequestId: string; body: string }>(
    `/reports/${id}/chat`,
  )

  const thread = useActiveThread(status)
  const messages = thread?.messages ?? []
  const isAuthError = error instanceof ApiError && (error.status === 401 || error.status === 403)

  if (isAuthError) return null
  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.red }]}>{error?.message}</Text>
      </View>
    )
  }

  const reportIdLabel = status?.reportId ?? ""
  const meta = `${reportIdLabel}`

  const handleSend = () => {
    const body = input.trim()
    if (!body) return
    const clientRequestId = `req-${Date.now()}`
    mutation.mutate(
      { clientRequestId, body },
      {
        onSuccess: () => {
          // Optimistically clear the input. Poll for the agent reply.
          setInput("")
          refetch()
        },
        onError: () => {
          Alert.alert("Send failed", "Try again")
        },
      },
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
          renderItem={({ item }) => (
            <ChatBubble
              message={item}
              isLast={item.id === messages[messages.length - 1]?.id}
              colors={colors}
              mono={typography.fontMono}
            />
          )}
          contentContainerStyle={styles.chatList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            <View style={styles.empty}>
              <EmptyState heading="No messages yet" body="Ask about this report to start." inline />
            </View>
          }
        />
        <View style={styles.composerWrap}>
          <SuggestionChips
            onPress={(chip) => setInput(chip)}
            colors={colors}
            hasMessages={messages.length > 0}
          />
          <View style={[styles.composer, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
            <TextInput
              style={[styles.field, { color: colors.foreground, fontFamily: typography.fontFamily }]}
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
              style={[styles.send, { opacity: !input.trim() || mutation.isPending ? 0.4 : 1 }]}
              accessibilityLabel="Send"
            >
              <Text style={styles.sendIcon}>{"\u2191"}</Text>
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
}: {
  onPress: (text: string) => void
  colors: ReturnType<typeof useTheme>["colors"]
  hasMessages: boolean
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
          <Text style={[styles.fchipText, { color: colors.foreground }]}>{chip}</Text>
        </Pressable>
      ))}
    </View>
  )
}

interface ChatBubbleProps {
  message: ChatMessage
  isLast: boolean
  colors: ReturnType<typeof useTheme>["colors"]
  mono: string
}

function ChatBubble({ message, isLast, colors, mono }: ChatBubbleProps) {
  const isMe = message.sender === "REVIEWER"
  const align = isMe ? "flex-end" : "flex-start"
  const bg = isMe ? colors.brand : colors.card
  const fg = isMe ? "#ffffff" : colors.foreground

  return (
    <View>
      {!isMe ? <Text style={[styles.who, { color: colors.muted }]}>Agent Bounty</Text> : null}
      <View style={[styles.bubble, { alignSelf: align, backgroundColor: bg, borderColor: colors["glass-edge"] }]}>
        {message.sender === "SYSTEM" ? (
          <Text style={[styles.typingDots, { color: colors.faint }]}>
            {"\u2022\u2022\u2022"}
          </Text>
        ) : (
          <Text style={[styles.bubbleText, { color: fg }]}>{message.body}</Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  chatList: {
    padding: 16,
    gap: 8,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
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
  },
  bubbleMe: {
    borderBottomRightRadius: 6,
  },
  bubbleAg: {
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    fontSize: 17,
    lineHeight: 1.35 * 17,
    wordWrap: "break-word",
  },
  typingDots: {
    fontSize: 20,
    lineHeight: 20,
    letterSpacing: -2,
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
    backgroundColor: "#6774F0",
  },
  sendIcon: {
    color: "#ffffff",
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
