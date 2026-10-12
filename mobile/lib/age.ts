/**
 * Relative age as the m4 to m6 mockups write it: "12 min", "3 h", "Yesterday", "2 d", "1 wk".
 * Lists add " ago" ("12 min ago"); "Yesterday" never takes it.
 */
export function ageText(iso: string, withAgo = false, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (minutes < 1) return "just now"
  const text =
    minutes < 60 ? `${minutes} min` : hours < 24 ? `${hours} h` : days < 2 ? "Yesterday" : days < 7 ? `${days} d` : `${Math.floor(days / 7)} wk`
  return withAgo && text !== "Yesterday" ? `${text} ago` : text
}
