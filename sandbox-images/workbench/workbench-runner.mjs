#!/usr/bin/env node
// The in-sandbox half of the pentest workbench (Phase 0, issue #327). It runs inside the offline,
// isolated workbench sandbox (see docs/pentest-workbench.md and lib/sandbox/workbench-probe.ts),
// reads its parameters from a JSON file the host wrote, invokes httpx, nuclei, or newman via
// spawnSync (never a shell), and prints one sentinel-prefixed JSON result line the host parses.
//
// Everything variable arrives in the params file as inert JSON data and is validated against the
// server-bound targetOrigin before any tool executes.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const RESULT_SENTINEL = "BOUNTYDESK_WORKBENCH_RESULT ";
const COLLECTION_PATH = "/tmp/bountydesk-newman-collection.json";

// Baked at build time (see the Dockerfile). The sandbox is offline and -duc skips updates, so this
// directory is the only source of nuclei templates.
const NUCLEI_TEMPLATES_DIR = process.env.BOUNTYDESK_NUCLEI_TEMPLATES_DIR || "/opt/nuclei-templates";

function templatesPresent(dir) {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const OFFLINE_ENV = {
  ...process.env,
  PDCP_API_KEY: "",
  DISABLE_UPDATE_CHECK: "true",
};

function emit(payload) {
  process.stdout.write(RESULT_SENTINEL + JSON.stringify(payload) + "\n");
  process.exit(0);
}

function fail(tool, message) {
  process.stderr.write(`workbench-runner: ${message}\n`);
  emit({ tool: tool || "httpx", exitCode: -1, stdout: "", stderr: String(message) });
}

function readParams() {
  const path = process.argv[2];
  if (!path) fail("httpx", "no params file argument");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail("httpx", `could not read params file: ${error.message}`);
  }
  let params;
  try {
    params = JSON.parse(raw);
  } catch (error) {
    fail("httpx", `params file is not valid JSON: ${error.message}`);
  }
  if (typeof params.targetOrigin !== "string" || typeof params.path !== "string") {
    fail(params?.tool, "params file is missing targetOrigin or path");
  }
  return params;
}

function resolveTargetUrl(targetOrigin, path) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("path must start with a single '/'");
  }
  const base = new URL(targetOrigin);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin) {
    throw new Error("path resolved outside targetOrigin");
  }
  return resolved.toString();
}

function runTool(binary, args, timeoutMs) {
  const run = spawnSync(binary, args, {
    env: OFFLINE_ENV,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) {
    return {
      exitCode: run.status ?? -1,
      stdout: run.stdout ?? "",
      stderr: `${run.stderr ?? ""}\n${run.error.message}`.trim(),
    };
  }
  return {
    exitCode: run.status ?? 0,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
}

const params = readParams();
const tool = params.tool;
const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 60_000;

let targetUrl;
try {
  targetUrl = resolveTargetUrl(params.targetOrigin, params.path);
} catch (error) {
  fail(tool, error.message);
}

if (tool === "httpx") {
  const result = runTool(
    "httpx",
    ["-u", targetUrl, "-silent", "-json", "-status-code", "-title", "-tech-detect", "-nc", "-duc"],
    timeoutMs,
  );
  emit({ tool: "httpx", ...result });
} else if (tool === "nuclei") {
  // A zero-template scan would look exactly like "no findings", so refuse loudly instead.
  if (!templatesPresent(NUCLEI_TEMPLATES_DIR)) {
    fail("nuclei", `nuclei templates missing or empty at ${NUCLEI_TEMPLATES_DIR}; refusing a zero-template scan`);
  }
  // Rate-limited: at nuclei's default 150 req/s an exposure scan took Juice Shop down in its 1 GiB
  // sandbox (seen live 2026-11-01), which would leave the session with no target to probe.
  const args = ["-u", targetUrl, "-t", NUCLEI_TEMPLATES_DIR, "-jsonl", "-silent", "-nc", "-duc", "-ni", "-rl", "30", "-c", "10"];
  if (Array.isArray(params.tags) && params.tags.length > 0) {
    const safeTags = params.tags.filter((t) => typeof t === "string" && /^[a-z0-9-]+$/.test(t));
    if (safeTags.length > 0) {
      args.push("-tags", safeTags.join(","));
    }
  }
  const result = runTool("nuclei", args, timeoutMs);
  emit({ tool: "nuclei", ...result });
} else if (tool === "newman") {
  const collection = {
    info: {
      name: "bountydesk-workbench-probe",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "probe",
        request: {
          method: "GET",
          header: [],
          url: targetUrl,
        },
      },
    ],
  };
  writeFileSync(COLLECTION_PATH, JSON.stringify(collection), "utf8");
  const result = runTool(
    "newman",
    ["run", COLLECTION_PATH, "--reporters", "cli", "--color", "off", "--timeout-request", "10000"],
    timeoutMs,
  );
  emit({ tool: "newman", ...result });
} else {
  fail(tool, `unsupported workbench tool: ${String(tool)}`);
}
