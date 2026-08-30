"use client";

import { useActionState } from "react";
import { FloppyDisk } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SandboxView } from "@/lib/trueforge/harness";

import { saveSandboxProvider, type ActionResult } from "./actions";

/** The harness catalog's seed values, which is what an unconfigured form starts from. */
const DEFAULTS = {
  execTimeoutMs: 60000,
  autoStopIntervalInMinutes: 5,
  autoArchiveIntervalInMinutes: 60,
  autoDeleteIntervalInMinutes: 7200,
};

// Zero disables an interval, which is a real setting. The exec timeout has no such meaning
// and TrueForge refuses it, so its floor is one rather than zero.
const FIELDS = [
  { name: "execTimeoutMs", label: "Exec timeout (ms)", min: 1 },
  { name: "autoStopIntervalInMinutes", label: "Auto stop (minutes)", min: 0 },
  { name: "autoArchiveIntervalInMinutes", label: "Auto archive (minutes)", min: 0 },
  { name: "autoDeleteIntervalInMinutes", label: "Auto delete (minutes)", min: 0 },
] as const;

export function SandboxForm({ sandbox }: { sandbox: SandboxView | null }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    saveSandboxProvider,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label key={field.name} className="flex flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">{field.label}</span>
            <Input
              name={field.name}
              type="number"
              min={field.min}
              defaultValue={sandbox ? sandbox[field.name] : DEFAULTS[field.name]}
            />
          </label>
        ))}

        <label className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">Daytona API key</span>
          {/* Rendered empty even when one is stored, and the stored value never reaches the
              browser. Blank on submit means the server replays what the harness holds. */}
          <Input
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={sandbox ? "Unchanged" : "dtn_..."}
          />
          <span className="text-meta text-muted-foreground">
            {sandbox ? "Leave blank to keep the key already stored." : "Required the first time."}
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={pending}>
          <RollingIcon icon={FloppyDisk} className="size-4" />
          {sandbox ? "Save sandbox provider" : "Configure sandbox provider"}
        </Button>
        {result?.ok ? <Badge variant="outline">Saved</Badge> : null}
      </div>

      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {/* Daytona is checked live on save, so a 422 here means the key itself was
              rejected, not that the request was malformed. */}
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
