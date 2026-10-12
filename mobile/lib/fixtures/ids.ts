/** Deterministic fixture ids. The mockups show BD-1042; the real id is a UUID, so the numeric part rides in the last group. */
export const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

export const DIGEST = "sha256:9f2c4e0a7b1d6c83e5a24f90b7d1c3e86a5f0b2d94c71e8a3b6d05f2c8e1a947"
export const CONTENT_HASH = "9f2c61ab07d4e8135c0be7a4f6d2189a3b5e04c7d91f8a26e0b34c5d7f1a82e6"
