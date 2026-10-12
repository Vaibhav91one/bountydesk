import { CONTENT_HASH, ago, rid } from "./ids"
import { verdictIdFor } from "./reports"

/** GET /reports/:id/chat: the m10 conversation, one finished thread. */
export function chat(reportId: string) {
  const at = new Date()
  at.setHours(9, 38, 0, 0)
  const t = at.toISOString()
  const msg = (n: number, sender: "REVIEWER" | "AGENT", body: string) => ({
    id: rid(2000 + n),
    clientRequestId: rid(3000 + n),
    sender,
    body,
    bodyHash: CONTENT_HASH,
    modelName: sender === "AGENT" ? "fixture" : null,
    providerTurnId: null,
    createdAt: t,
  })
  return {
    reportId,
    threads: [
      {
        id: rid(4000),
        verdictId: verdictIdFor(1042),
        verdictRevision: 1,
        verdictContentHash: CONTENT_HASH,
        status: "DONE",
        createdAt: ago(5),
        updatedAt: ago(1),
        messages: [
          msg(1, "REVIEWER", "Why is this rated High?"),
          msg(2, "AGENT", "The payload is stored, so it runs for every visitor who opens the search page. The oracle saw the canary execute, not just reflect."),
          msg(3, "REVIEWER", "Did it need a login?"),
          msg(4, "AGENT", "No. The write probe used the public feedback endpoint, inside the sandbox only."),
        ],
      },
    ],
  }
}
