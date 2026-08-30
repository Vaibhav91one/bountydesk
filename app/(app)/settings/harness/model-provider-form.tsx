"use client";

import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogProviderView, ModelProviderView, ModelView } from "@/lib/trueforge/harness";

import { saveModelProvider, type ActionResult } from "./actions";

const WELL_KNOWN = [
  "openai",
  "anthropic",
  "google-gemini",
  "fireworks",
  "zai",
  "moonshot",
  "together",
  "alibaba",
] as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * One provider's whole configuration, saved in a single PUT.
 *
 * The model list lives in local state and travels as one hidden field because the harness
 * replaces a provider wholesale rather than merging: adding and removing a model are both
 * "here is the complete list I want", which is also how TrueForge's own settings UI
 * implements its per-model trash icon.
 *
 * `provider` absent means this is the add form, with a type picker that prefills models from
 * the catalog. Present means the type and name are already decided and only the models, base
 * URL and key can change.
 */
export function ModelProviderForm({
  provider,
  catalog,
}: {
  provider?: ModelProviderView;
  catalog: CatalogProviderView[];
}) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    saveModelProvider,
    null,
  );

  const [type, setType] = useState<string>(provider?.type ?? "openai");
  const [name, setName] = useState(provider?.name ?? "");
  const [models, setModels] = useState<ModelView[]>(provider?.models ?? catalogModels(catalog, "openai"));
  const [draft, setDraft] = useState({ modelId: "", name: "" });

  function pickType(next: string) {
    setType(next);
    if (!provider) setModels(catalogModels(catalog, next));
  }

  function addDraft() {
    const modelId = draft.modelId.trim();
    // TrueForge's ResourceName pattern has no dots, so a model id like gpt-5.4-mini cannot be
    // its own name. Defaulting the name to a dot-free version of the id saves typing both.
    const modelName = (draft.name.trim() || modelId).replaceAll(".", "-");
    if (!modelId || models.some((model) => model.name === modelName)) return;
    setModels([...models, { modelId, name: modelName, contextLength: null, maxOutputTokens: null }]);
    setDraft({ modelId: "", name: "" });
  }

  const lastModel = models.length <= 1;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="type" value={type} />
      <input
        type="hidden"
        name="models"
        value={JSON.stringify(
          models.map((model) => ({
            name: model.name,
            modelId: model.modelId,
            ...(model.contextLength ? { contextLength: model.contextLength } : {}),
            ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
          })),
        )}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {provider ? (
          <input type="hidden" name="name" value={provider.type === "custom" ? provider.name : ""} />
        ) : (
          <Field label="Provider">
            <select
              value={type}
              onChange={(event) => pickType(event.target.value)}
              className="h-9 rounded-md border border-transparent bg-input/50 px-3 text-sm outline-none focus-visible:border-ring"
            >
              {WELL_KNOWN.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              <option value="custom">custom (OpenAI-compatible)</option>
            </select>
          </Field>
        )}

        {!provider && type === "custom" ? (
          <Field label="Name">
            <Input name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="deepseek" />
          </Field>
        ) : null}

        {type === "custom" || provider?.type === "custom" ? (
          <Field label="Base URL">
            <Input name="baseUrl" defaultValue={provider?.baseUrl ?? ""} placeholder="https://api.deepseek.com/v1" />
          </Field>
        ) : (
          <input type="hidden" name="baseUrl" value={provider?.baseUrl ?? ""} />
        )}

        <Field
          label="API key"
          hint={provider ? "Leave blank to keep the key already stored." : "Required the first time."}
        >
          {/* Always empty, and the stored value is never sent to the browser. A blank submit
              makes the server replay whatever the harness already holds. */}
          <Input name="apiKey" type="password" autoComplete="off" placeholder={provider ? "Unchanged" : "sk-..."} />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-meta text-muted-foreground">Models</span>
        <ul className="flex flex-col">
          {models.map((model) => (
            <li
              key={model.name}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-2 last:border-b-0"
            >
              <span className="min-w-0 text-body text-foreground">
                {model.name}
                <span className="ml-2 font-mono text-meta break-all text-muted-foreground">{model.modelId}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={lastModel}
                title={lastModel ? "A provider must keep at least one model." : undefined}
                onClick={() => setModels(models.filter((other) => other.name !== model.name))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Model id">
            <Input
              value={draft.modelId}
              onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
              placeholder="gpt-5-mini"
            />
          </Field>
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="same as the id"
            />
          </Field>
          <Button type="button" size="sm" variant="outline" onClick={addDraft}>
            Add model
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={pending}>
          {provider ? "Save provider" : "Add provider"}
        </Button>
        {result?.ok ? <Badge variant="outline">Saved</Badge> : null}
      </div>

      {result && !result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}

/** The harness's own preset list for a type, so nobody types model ids by hand on first run. */
function catalogModels(catalog: CatalogProviderView[], type: string): ModelView[] {
  return catalog.find((entry) => entry.type === type)?.models ?? [];
}
