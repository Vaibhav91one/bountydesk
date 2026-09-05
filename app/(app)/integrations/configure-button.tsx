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
      {/* One control. Unbinding a repository has no helper behind it, and a disabled button
          for it was a permanent "coming soon" taking up half the row. Removing the App's
          access to a repository is GitHub's own screen, which the panel links to. */}
      <Button type="submit" size="sm" loading={pending}>
        {label}
      </Button>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
