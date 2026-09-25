#!/usr/bin/env node
// The in-sandbox half of the browser probe. It runs inside the offline, isolated browser sandbox
// (see docs/browser-probe.md and lib/sandbox/browser-probe.ts), reads its parameters from a JSON
// file the host wrote, drives webcmd to render each navigation, and prints one result line the
// host parses. It never decides anything: it reports what it rendered (DOM, title, console,
// dialogs), and BountyDesk on the host greps that for the run's secret canary itself.
//
// This file is data to the host: the host's exec command is a fixed string (base64-decode the
// params to a file, then `node browser-oracle.mjs <params>`), so nothing a recipe or the agent
// supplies is ever spliced into a shell. Everything variable arrives in the params file as inert
// data and is fed to page.goto as a URL, whose "execution" is the whole point and is contained by
// the sandbox's networkBlockAll (no egress) and its single private link to the target.
//
// Verified offline against webcmd 0.8.4 in the built image: the CLI shape `webcmd session create` /
// `webcmd --session <id> browser run --stdin`, and that `page.on('dialog')` and `page.on('console')`
// both fire inside webcmd's QuickJS runtime. The image pins that version because the result
// envelope and the config format below are webcmd internals.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RESULT_SENTINEL = "BOUNTYDESK_BROWSER_RESULT ";

// Kill webcmd's two optional outbound calls at the source. The sandbox's networkBlockAll already
// denies them, so this is defense in depth, not the boundary: it keeps the driver from wasting the
// 2s each on a call that cannot succeed offline.
const OFFLINE_ENV = {
  ...process.env,
  WEBCMD_GLOBAL_MEMORY: "off",
  WEBCMD_CANDIDATE_PUBLIC_IP: "off",
  // The image bakes a config here that selects the system Chromium; without it webcmd tries to
  // download its own browser, which cannot work offline. Set here too, not only in the image ENV,
  // so the driver does not depend on the exec API passing image env through.
  WEBCMD_CONFIG_DIR: "/opt/webcmd",
};

function fail(message) {
  // Even a hard failure prints a well-formed result so the host reads "nothing rendered" rather
  // than an unparseable line. Errors go to stderr for the operator, never onto the result line.
  process.stderr.write(`browser-oracle: ${message}\n`);
  process.stdout.write(RESULT_SENTINEL + JSON.stringify({ steps: [] }) + "\n");
  process.exit(0);
}

function readParams() {
  const path = process.argv[2];
  if (!path) fail("no params file argument");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`could not read params file: ${error.message}`);
  }
  let params;
  try {
    params = JSON.parse(raw);
  } catch (error) {
    fail(`params file is not valid JSON: ${error.message}`);
  }
  if (typeof params.targetOrigin !== "string" || !Array.isArray(params.steps)) {
    fail("params file is missing targetOrigin or steps");
  }
  return params;
}

// A fresh document per step. Two navigations that differ only in the fragment do not reload the
// page, so a cache-busting query before the '#' forces a real load and resets title/DOM between
// the negative control and the exploit. The server sees this nonce; it never sees the fragment,
// which is where the canary rides.
function buildUrl(targetOrigin, step) {
  const nonce = `bdnonce=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const path = step.path.startsWith("/") ? step.path : `/${step.path}`;
  const [beforeHash] = path.split("#");
  const sep = beforeHash.includes("?") ? "&" : "?";
  const withNonce = `${beforeHash}${sep}${nonce}`;
  const fragment = step.hashPayload ? `#${step.hashPayload}` : "";
  return `${targetOrigin}${withNonce}${fragment}`;
}

// The webcmd program (runs in webcmd's QuickJS/Playwright runtime). It registers the console and
// dialog handlers before navigating, loads the URL, lets the page settle, then returns the
// observation. The values are interpolated as JSON literals, so they are data inside the program,
// never code.
function browserProgram(url, navTimeoutMs, settleMs, maxDomChars, waitUntil) {
  return `
const consoleLines = [];
const dialogMessages = [];
try { page.on('console', (m) => { try { consoleLines.push(String(m.text())); } catch (e) {} }); } catch (e) {}
try { page.on('dialog', async (d) => { try { dialogMessages.push(String(d.message())); } catch (e) {} try { await d.dismiss(); } catch (e) {} }); } catch (e) {}
let navigated = false;
try { await page.goto(${JSON.stringify(url)}, { waitUntil: ${JSON.stringify(waitUntil)}, timeout: ${navTimeoutMs} }); navigated = true; } catch (e) {}
try { await page.waitForTimeout(${settleMs}); } catch (e) {}
let title = '';
let dom = '';
try { title = String(await page.title()); } catch (e) {}
try { dom = String(await page.evaluate(() => document.documentElement.outerHTML)); } catch (e) {}
return { navigated, title, dom: dom.slice(0, ${maxDomChars}), consoleText: consoleLines.join('\\n'), dialogFired: dialogMessages.length > 0, dialogMessages };
`;
}

function webcmd(args, input) {
  const run = spawnSync("webcmd", args, {
    input: input ?? "",
    env: OFFLINE_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw new Error(`spawn webcmd failed: ${run.error.message}`);
  return { code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// webcmd prints its program's return value on stdout, mixed with daemon lines. Take the last
// balanced JSON object in the output, so a status line that happens to contain a brace does not
// derail the parse.
function extractJson(stdout) {
  const end = stdout.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (stdout[i] === "}") depth += 1;
    else if (stdout[i] === "{") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(i, end + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Playwright's navigation-complete signals. 'load' waits for every subresource, which a heavy SPA
// (or a page with one slow image) never fires inside the timeout, so page.goto throws and the step
// reports navigated:false even though the DOM parsed and any DOM-XSS sink already ran. The host
// picks the signal (see browser-probe.ts); 'domcontentloaded' is the safe default here.
const WAIT_UNTIL = ["load", "domcontentloaded", "commit", "networkidle"];

function runStep(sessionId, params, step) {
  const url = buildUrl(params.targetOrigin, step);
  const waitUntil = WAIT_UNTIL.includes(params.waitUntil) ? params.waitUntil : "domcontentloaded";
  const program = browserProgram(
    url,
    Number(params.navTimeoutMs) || 15000,
    Number(params.settleMs) || 1500,
    Number(params.maxDomChars) || 1000000,
    waitUntil,
  );
  const result = webcmd(["--session", sessionId, "browser", "run", "--stdin"], program);
  // webcmd wraps the program's return value in an envelope ({ ok, result, logs, page, ... }), so
  // the observation is `result`. A run that threw has no result and counts as nothing rendered.
  const observation = extractJson(result.stdout)?.result;
  if (!observation || typeof observation !== "object") {
    process.stderr.write(`browser-oracle: step ${step.label} produced no parseable result: ${result.stderr.slice(0, 400)}\n`);
    return { label: step.label, navigated: false, title: "", dom: "", consoleText: "", dialogFired: false, dialogMessages: [] };
  }
  return { label: step.label, ...observation };
}

function main() {
  const params = readParams();

  const doctor = webcmd(["doctor"], "");
  if (doctor.code !== 0) {
    fail(`webcmd doctor failed (code ${doctor.code}): ${doctor.stderr.slice(0, 400)}`);
  }

  const created = webcmd(["session", "create", "bountydesk-browser-probe", "-f", "json"], "");
  const session = extractJson(created.stdout);
  const sessionId = session && (session.id || session.sessionId);
  if (!sessionId) {
    fail(`could not create a webcmd session: ${created.stderr.slice(0, 400)}`);
  }

  const steps = params.steps.map((step) => runStep(sessionId, params, step));
  process.stdout.write(RESULT_SENTINEL + JSON.stringify({ steps }) + "\n");
}

main();
