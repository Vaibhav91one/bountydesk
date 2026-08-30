"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireReviewer } from "@/lib/auth/dal";
import { resolveApiKey, WELL_KNOWN_PROVIDER_TYPES } from "@/lib/trueforge/desired";
import {
  applyManaged,
  harnessError,
  saveModelProvider as putModelProvider,
  saveSandboxProvider as putSandboxProvider,
  storedModelProviderKey,
  storedSandboxKey,
} from "@/lib/trueforge/harness";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Three verbs, not a proxy.
 *
 * A catch-all route forwarding browser-shaped requests to any TrueForge path would put
 * `sessions.createTurn` and `user.tool_approval` behind the same handler that edits a model
 * provider, and the approval gate is the one thing AGENTS.md calls non-skippable. These
 * actions can only apply managed resources and save the two credential-bearing settings.
 *
 * Each one re-checks the reviewer session first: a server action is a POST that arrives on
 * its own, so the (app) layout's guard never runs for it.
 */

const numeric = z.coerce.number().int().nonnegative();

const modelSchema = z.object({
  name: z.string().min(1),
  modelId: z.string().min(1),
  contextLength: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const providerSchema = z
  .object({
    type: z.enum([...WELL_KNOWN_PROVIDER_TYPES, "custom"]),
    name: z.string().trim().optional(),
    baseUrl: z.string().trim().optional(),
    apiKey: z.string(),
    // The whole model list travels as one field because the PUT is a full replace: sending
    // the models the provider should end up with is the only way to express a removal.
    models: z.string().transform((raw, ctx) => {
      const parsed = modelSchema.array().safeParse(JSON.parse(raw));
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "malformed model list" });
        return z.NEVER;
      }
      return parsed.data;
    }),
  })
  .refine((input) => input.models.length > 0, {
    message: "A provider needs at least one model. Removing the last one would leave nothing to select.",
  })
  .refine((input) => input.type !== "custom" || (input.name && input.baseUrl), {
    message: "A custom provider needs both a name and a base URL.",
  });

export async function saveModelProvider(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireReviewer();

  const parsed = providerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const input = parsed.data;

  try {
    // Well-known types are named after their type; only `custom` carries a name of its own.
    const recordName = input.type === "custom" ? input.name! : input.type;
    const apiKey = resolveApiKey(input.apiKey, await storedModelProviderKey(recordName));
    if (!apiKey) return { ok: false, error: "An API key is required the first time." };

    await putModelProvider({
      type: input.type,
      name: input.name,
      baseUrl: input.baseUrl || undefined,
      apiKey,
      models: input.models,
    });
  } catch (error) {
    return { ok: false, error: harnessError(error) };
  }

  revalidatePath("/settings/harness");
  return { ok: true };
}

const sandboxSchema = z.object({
  apiKey: z.string(),
  execTimeoutMs: numeric,
  autoStopIntervalInMinutes: numeric,
  autoArchiveIntervalInMinutes: numeric,
  autoDeleteIntervalInMinutes: numeric,
});

export async function saveSandboxProvider(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireReviewer();

  const parsed = sandboxSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  try {
    const apiKey = resolveApiKey(parsed.data.apiKey, await storedSandboxKey());
    if (!apiKey) return { ok: false, error: "An API key is required the first time." };

    await putSandboxProvider({ ...parsed.data, apiKey });
  } catch (error) {
    return { ok: false, error: harnessError(error) };
  }

  revalidatePath("/settings/harness");
  return { ok: true };
}

const scopeSchema = z.enum(["connectors", "skills", "agent"]);

export async function applyManagedResources(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireReviewer();

  const scope = scopeSchema.safeParse(formData.get("scope"));
  if (!scope.success) return { ok: false, error: "Unknown thing to apply." };

  try {
    await applyManaged([scope.data]);
  } catch (error) {
    return { ok: false, error: harnessError(error) };
  }

  revalidatePath("/settings/harness");
  return { ok: true };
}
