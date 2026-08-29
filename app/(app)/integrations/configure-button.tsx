"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { configureRepository, rotateRepository, type ConfigureResult } from "./actions";

export function ConfigureButton({
  repoId,
  label,
  configured,
}: {
  repoId: number;
  label: string;
  configured: boolean;
}) {
  const [result, action, pending] = useActionState<ConfigureResult | null, FormData>(
    configured ? rotateRepository : configureRepository,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="repoId" value={repoId} />
      <div className="flex flex-nowrap gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {label}
        </Button>
        {/* No unbind helper exists yet, and a wrong one either re-opens intake or wrongly
            closes it. Disabled beats a button that lies about what it does. */}
        <Button type="button" size="sm" variant="outline" disabled title="Not yet available">
          Remove repository
        </Button>
      </div>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
