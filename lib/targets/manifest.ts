import type { TargetDefinition } from "./registry";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ENV_PREFIX_RE = /^[A-Z0-9_]{1,80}$/;
const IMAGE_NAME_RE = /^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/;

export type TargetManifest = {
  name: string;
  repoFullName: string;
  imageName: string;
  baseUrl: string;
  readinessPath: string;
  startCommand?: string;
  envPrefix?: string;
  scopeRules?: unknown[];
};

export function parseTargetManifest(text: string): TargetDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("target manifest is not valid JSON");
  }
  return targetDefinitionFromManifest(parsed);
}

export function targetDefinitionFromManifest(input: unknown): TargetDefinition {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("target manifest must be a JSON object");
  }

  const manifest = input as Record<string, unknown>;
  const name = readString(manifest, "name");
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error("target manifest name must be lowercase letters, numbers, dot, dash or underscore");
  }

  const imageName = readString(manifest, "imageName");
  if (!IMAGE_NAME_RE.test(imageName) || imageName.includes("@") || /:[^/]+$/.test(imageName)) {
    throw new Error("target manifest imageName must be an untagged ghcr.io image name");
  }

  const baseUrl = readString(manifest, "baseUrl");
  validateLocalHttpBaseUrl(baseUrl);

  const readinessPath = normalizePath(readString(manifest, "readinessPath"), "readinessPath");
  const startCommand = optionalString(manifest, "startCommand");
  if (startCommand !== undefined) validateStartCommand(startCommand);

  const repoFullName = readString(manifest, "repoFullName");
  const envPrefix = optionalString(manifest, "envPrefix") ?? envPrefixFromName(name);
  if (!ENV_PREFIX_RE.test(envPrefix)) {
    throw new Error("target manifest envPrefix must use uppercase letters, numbers or underscores");
  }

  const scopeRules = manifest.scopeRules ?? [{ allow: "localhost" }];
  validateScopeRules(scopeRules);

  return {
    name,
    repoFullName,
    envPrefix,
    imageName,
    config: {
      baseUrl,
      readinessPath,
    },
    scopeRules: scopeRules as unknown[],
    provisioning: {
      readinessPath,
      ...(startCommand ? { startCommand } : {}),
    },
  };
}

export function envPrefixFromName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`target manifest ${key} must be a nonempty string`);
  }
  return value;
}

function optionalString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`target manifest ${key} must be a nonempty string when present`);
  }
  return value;
}

function validateLocalHttpBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("target manifest baseUrl must be a valid URL");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("target manifest baseUrl must use http");
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("target manifest baseUrl must point at loopback");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("target manifest baseUrl must not include credentials, query or fragment");
  }
}

function normalizePath(value: string, key: string): string {
  if (!value.startsWith("/") || value.includes("://") || /[\r\n]/.test(value)) {
    throw new Error(`target manifest ${key} must be a same-origin absolute path`);
  }
  return value;
}

function validateStartCommand(value: string): void {
  if (value.length > 1_000 || /[\r\n]/.test(value)) {
    throw new Error("target manifest startCommand must be a single line under 1000 characters");
  }
}

function validateScopeRules(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("target manifest scopeRules must be a nonempty array");
  }
  for (const rule of value) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      (rule as { allow?: unknown }).allow !== "localhost"
    ) {
      throw new Error("target manifest scopeRules may only allow localhost today");
    }
  }
}
