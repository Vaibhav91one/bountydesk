"use client";

import { useActionState } from "react";

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

const FIELDS = [
  { name: "execTimeoutMs", label: "Exec timeout (ms)" },
  { name: "autoStopIntervalInMinutes", label: "Auto stop (minutes)" },
  { name: "autoArchiveIntervalInMinutes", label: "Auto archive (minutes)" },
  { name: "autoDeleteIntervalInMinutes", label: "Auto delete (minutes)" },
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
              min={0}
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
