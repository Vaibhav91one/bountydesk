"use client";

import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

/**
 * A one-time-code input: one box per digit, the pattern people expect from a code screen.
 * Typing a digit advances, backspace on an empty box steps back, and a pasted code fills the row.
 * `onComplete` fires once all `length` digits are present so the caller can submit without a button.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  length = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  length?: number;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");

  function commit(next: string): string {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
    return clean;
  }

  function handleChange(index: number, raw: string) {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const arr = chars.slice();
    arr[index] = digit;
    commit(arr.join(""));
    if (digit && index < length - 1) refs.current[index + 1]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !chars[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text");
    const next = commit(pasted);
    refs.current[Math.min(next.length, length - 1)]?.focus();
  }

  return (
    <div className="flex items-center gap-2" onPaste={handlePaste}>
      {chars.map((char, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          value={char}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          disabled={disabled}
          aria-label={`Digit ${index + 1}`}
          className="size-12 rounded-md border border-border/50 bg-background text-center text-heading text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
