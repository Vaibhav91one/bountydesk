import { type SeedStep } from "./build-plan";
import { type DatastoreCreds, type DatastoreRecipe } from "./datastore-recipes";

/**
 * Turn a compose app-plus-datastore into one self-contained image. The reproduction sandbox boots one
 * container with no network, so a second `db` service and an image pull are both impossible there; the
 * datastore has to be installed into the app image and its data seeded at build so a fresh offline
 * sandbox starts populated. This is compose-declaration-driven synthesis, not a compose runtime: it
 * reads which service is the app and which are datastores, then emits a Dockerfile that installs the
 * datastore, points the app at loopback, seeds once at build, and starts both from one entrypoint.
 *
 * The driver builds the app service's own Dockerfile first and passes the resulting local image tag as
 * `appImageRef`; this Dockerfile is `FROM` that, so the app's build is unchanged and only the datastore
 * and seed are layered on.
 */

const ENTRYPOINT_PATH = "/usr/local/bin/bountydesk-start";

export type SynthesizeInput = {
  /** The locally-built app image the driver produced from the compose app service. */
  appImageRef: string;
  /** Datastores to install and seed, resolved to a recipe and the compose-declared credentials. */
  datastores: Array<{ recipe: DatastoreRecipe; creds: DatastoreCreds }>;
  /** In-place edits to the app's config so it reaches the datastore on 127.0.0.1 rather than the
   *  compose service name. Each is a literal search/replace in one file. */
  configRewrites?: Array<{ file: string; from: string; to: string }>;
  /** Environment values baked into the image, e.g. a DB host env the app reads set to 127.0.0.1. */
  envOverrides?: Record<string, string>;
  /** How to seed at build once the datastore is up. */
  seed: SeedStep;
  /** The git commit, written to /etc/bountydesk-build-marker so the reproduction sandbox can prove
   *  which build booted. */
  buildMarker: string;
  /** The foreground command that runs the app (e.g. "apache2-foreground"); used both to seed at build
   *  and as the last line of the boot entrypoint. */
  appStartCommand: string;
  /** Loopback port the app serves on, used to wait for it during an http seed. */
  appPort: number;
};

export function synthesizeComposeDockerfile(input: SynthesizeInput): string {
  if (input.datastores.length === 0) {
    throw new Error("compose synthesis needs at least one datastore; a self-contained app is the dockerfile strategy");
  }

  const lines: string[] = [];
  lines.push(`FROM ${input.appImageRef}`);
  lines.push("USER root");
  for (const [key, value] of Object.entries(input.envOverrides ?? {})) {
    lines.push(`ENV ${key}=${shArg(value)}`);
  }
  lines.push("");

  // A seed that drives the app over HTTP needs a client the app base may not ship. Both the http seed
  // and a command seed that runs the app's own setup endpoint (DVWA's /setup.php) use curl, so install
  // it for either. A none seed needs nothing.
  const needsCurl = input.seed.kind !== "none";
  const installParts = input.datastores.map((d) => d.recipe.install());
  if (needsCurl) {
    installParts.unshift(
      "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*",
    );
  }
  lines.push(`RUN ${installParts.join(" \\\n && ")}`);
  lines.push("");

  if (input.configRewrites?.length) {
    const rewrites = input.configRewrites.map(
      (r) => `sed -i ${sed(r.from, r.to)} ${shArg(r.file)}`,
    );
    lines.push("# Point the app at the datastore on loopback, not the compose service name.");
    lines.push(`RUN ${rewrites.join(" \\\n && ")}`);
    lines.push("");
  }

  // The one build-time seed: bring every datastore up, run the app's seed, and shut down cleanly, all
  // in one RUN so the seeded data directories are flushed into a single committed layer.
  const seedSteps: string[] = ["set -eu"];
  for (const d of input.datastores) seedSteps.push(d.recipe.bringUpAndInit(d.creds));
  seedSteps.push(renderSeed(input));
  for (const d of input.datastores) seedSteps.push(d.recipe.shutdown());
  lines.push("# Seed at build so the offline sandbox boots with the data already present.");
  lines.push(`RUN ${seedSteps.join(" \\\n && ")}`);
  lines.push("");

  lines.push(`RUN mkdir -p /etc && echo ${shArg(input.buildMarker)} > /etc/bountydesk-build-marker`);
  lines.push("");

  // The entrypoint starts each datastore and waits for it, then execs the app in the foreground so the
  // container's main process is the app. Written as a small script rather than a shell -c so the image
  // has one clear start command.
  const bootLines = ["#!/bin/sh", "set -e"];
  for (const d of input.datastores) bootLines.push(d.recipe.bootAndWait());
  bootLines.push(`exec ${input.appStartCommand}`);
  const printfArgs = bootLines.map((l) => shArg(l)).join(" ");
  lines.push(`RUN printf '%s\\n' ${printfArgs} > ${ENTRYPOINT_PATH} && chmod +x ${ENTRYPOINT_PATH}`);
  lines.push(`ENTRYPOINT ["${ENTRYPOINT_PATH}"]`);
  lines.push("");

  return lines.join("\n");
}

function renderSeed(input: SynthesizeInput): string {
  const { seed } = input;
  if (seed.kind === "none") return "true";
  if (seed.kind === "command") return seed.command;
  // http: start the app in the background against the up datastore, wait for it to answer, hit the
  // seed path, then stop the app. The datastore stays up for the recipe's shutdown afterwards.
  const base = `http://127.0.0.1:${input.appPort}`;
  return [
    `( ${input.appStartCommand} & echo $! > /tmp/bd-seed-app.pid )`,
    `for i in $(seq 1 60); do curl -fsS -o /dev/null ${base}/ 2>/dev/null && break; sleep 1; done`,
    `curl -fsS -X ${seed.method} ${base}${seed.path} -o /dev/null`,
    `kill "$(cat /tmp/bd-seed-app.pid)" 2>/dev/null || true`,
  ].join(" && ");
}

/** Single-quote for POSIX sh so a config value or path cannot break the generated command. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A `sed -i` script that replaces the first literal occurrence of `from` with `to`. The pattern and
 *  the replacement escape different metacharacter sets: the pattern is a BRE, the replacement only
 *  needs `\`, `&` and the delimiter escaped. Used only for the narrow host rewrite in a config file. */
function sed(from: string, to: string): string {
  const pattern = from.replace(/[\\/.*[\]^$]/g, "\\$&");
  const replacement = to.replace(/[\\/&]/g, "\\$&");
  return `'s/${pattern}/${replacement}/'`;
}
