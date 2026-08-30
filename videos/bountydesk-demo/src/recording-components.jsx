import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const reports = [
  { title: "SQL injection in /rest/products/search", state: "Reproducing", sev: "Critical" },
  { title: "Auth bypass via SQL injection on login", state: "Awaiting approval", sev: "Critical" },
  { title: "Directory traversal in upload handler", state: "Analysis only", sev: "High" },
  { title: "Missing headers on marketing site", state: "Out of scope", sev: "Low" },
];

const stageRows = [
  ["GitHub App", "Signed issue delivery", "ok"],
  ["Target profile", "Vaibhav91one/juice-shop @ v17.3.0", "ok"],
  ["Scope guard", "Server-bound repo and commit", "ok"],
];

const traceRows = [
  "negative control passed",
  "fresh canary seeded",
  "poc executed against pinned target",
  "external oracle observed canary",
];

function Chrome({ children, tone = "dark", bare = false, portrait = false }) {
  return (
    <div className={`bd-chrome ${tone}${bare ? " bare" : ""}${portrait ? " portrait" : ""}`}>
      {!bare && <div className="topbar">
        <div className="traffic">
          <span />
          <span />
          <span />
        </div>
        <div className="brand-pill">
          <img src="assets/logo-small.svg" alt="" />
          <span>BountyDesk</span>
        </div>
        <div className="url">Review queue</div>
        <div className="nav-item active">Reports</div>
        <div className="nav-item">Runs</div>
        <div className="nav-item">Scope</div>
        <div className="nav-item">Approvals</div>
      </div>}
      {children}
    </div>
  );
}

function StatusPill({ children, tone = "violet" }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

function QueueCards() {
  return (
    <div className="queue-grid">
      {reports.map((report, index) => (
        <div className="report-card" key={report.title}>
          <div className="card-kicker">Report 0{index + 1}</div>
          <h3>{report.title}</h3>
          <div className="card-row">
            <StatusPill tone={index === 3 ? "muted" : index === 2 ? "amber" : "violet"}>{report.state}</StatusPill>
            <span>{report.sev}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Shot({ id }) {
  switch (id) {
    case "home":
      return (
        <Chrome bare>
          <div className="hero-shot">
            <div>
              <div className="eyebrow">Automated triage, human gate</div>
              <h1>A signed report becomes an evidence packet.</h1>
              <p>BountyDesk checks scope, reproduces against a pinned target, and waits for approval before delivery.</p>
            </div>
            <div className="mascot-ring"><img src="assets/mascot-idle.svg" /></div>
          </div>
        </Chrome>
      );
    case "intake":
      return (
        <Chrome>
          <div className="two-col">
            <section>
              <div className="eyebrow">Intake</div>
              <h2>Identity is not repo access.</h2>
              <p>OAuth identifies the user. The GitHub App grants the repo. The server binds the issue to the target profile.</p>
            </section>
            <div className="stack-panel">
              {stageRows.map(([label, value, tone]) => (
                <div className="row" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <StatusPill tone={tone}>bound</StatusPill>
                </div>
              ))}
            </div>
          </div>
        </Chrome>
      );
    case "fixture":
      return (
        <Chrome>
          <div className="verdict-panel">
            <div>
              <div className="eyebrow">Fixture gate</div>
              <h2>No fixture, no reproduced verdict.</h2>
              <p>Without a defender-authored fixture, negative control, and oracle adapter, the run stops at analysis only.</p>
            </div>
            <div className="terminal-block">
              <code>$ bd triage report-1842</code>
              <code className="warn">fixture_missing: true</code>
              <code>verdict: ANALYSIS_ONLY</code>
            </div>
          </div>
        </Chrome>
      );
    case "target":
      return (
        <Chrome>
          <div className="target-map">
            <div className="node large">Target profile</div>
            <div className="node">Exact commit</div>
            <div className="node">Pinned snapshot</div>
            <div className="node">Canary fixture</div>
            <div className="link one" />
            <div className="link two" />
            <div className="link three" />
            <aside>
              <div className="eyebrow">Reproduction</div>
              <h2>Target comes from the server.</h2>
              <p>Clone, deploy, and egress are bound at the capability boundary, never from model text.</p>
            </aside>
          </div>
        </Chrome>
      );
    case "negative":
      return (
        <Chrome>
          <div className="run-log">
            <div>
              <div className="eyebrow">Control first</div>
              <h2>A green script is not reproduction.</h2>
              <p>The run proves the exploit only after the negative control fails to observe the canary.</p>
            </div>
            <div className="checks">
              <div><span /> Negative control <strong>passed</strong></div>
              <div><span /> Fresh canary <strong>seeded</strong></div>
              <div><span /> PoC execution <strong>pending</strong></div>
            </div>
          </div>
        </Chrome>
      );
    case "trace":
      return (
        <Chrome>
          <div className="trace">
            <div className="terminal-block big">
              {traceRows.map((row) => <code key={row}>{row}</code>)}
            </div>
            <div>
              <div className="eyebrow">TrueForge session</div>
              <h2>The transcript is evidence, not the judge.</h2>
              <p>The model can drive the run. The oracle decides whether the canary was observed.</p>
            </div>
          </div>
        </Chrome>
      );
    case "oracle":
      return (
        <Chrome tone="light">
          <div className="oracle">
            <div className="packet">
              <div className="packet-top">
                <span>Evidence packet</span>
                <StatusPill tone="green">REPRODUCED</StatusPill>
              </div>
              <pre>control: passed{"\n"}canary: seeded per run{"\n"}oracle: canary observed</pre>
              <div className="hashes">
                <span>target 1867b926</span>
                <span>payload sha256:c0e7</span>
              </div>
            </div>
            <img src="assets/mascot-canary-found.svg" />
          </div>
        </Chrome>
      );
    case "queue":
      return (
        <Chrome>
          <div className="queue-shot">
            <div>
              <div className="eyebrow">Review queue</div>
              <h2>Every report has a state. None has a guess.</h2>
            </div>
            <QueueCards />
          </div>
        </Chrome>
      );
    case "scope":
      return (
        <Chrome>
          <div className="scope">
            <div className="scope-card in"><span>in scope</span><strong>juice-shop</strong></div>
            <div className="scope-card out"><span>blocked</span><strong>marketing.example</strong></div>
            <div>
              <div className="eyebrow">Scope guard</div>
              <h2>Scope is a capability boundary.</h2>
              <p>The agent never widens target access by reading strings from a report or a log.</p>
            </div>
          </div>
        </Chrome>
      );
    case "lifecycle":
      return (
        <Chrome>
          <div className="lifecycle">
            {["TRIAGING", "REPRODUCING", "AWAITING_APPROVAL", "DELIVERING", "DELIVERED"].map((state) => (
              <div className="state" key={state}>{state}</div>
            ))}
          </div>
        </Chrome>
      );
    case "ready":
      return (
        <Chrome>
          <div className="compare">
            <div className="status-file">
              <span>status.txt</span>
              <strong>READY</strong>
              <small>target answered health check</small>
            </div>
            <div>
              <div className="eyebrow">Evidence boundary</div>
              <h2>READY never means reproduced.</h2>
              <p>A sandbox status file reports target readiness only. The oracle owns the verdict.</p>
            </div>
          </div>
        </Chrome>
      );
    case "similar":
      return (
        <Chrome>
          <div className="similar">
            <div className="matches">
              <div><strong>92%</strong><span>same endpoint</span></div>
              <div><strong>81%</strong><span>same payload shape</span></div>
              <div><strong>73%</strong><span>same component</span></div>
            </div>
            <section>
              <div className="eyebrow">Duplicate handling</div>
              <h2>Similar reports go to a human.</h2>
              <p>Only exact delivery replays are automatic no-ops.</p>
            </section>
          </div>
        </Chrome>
      );
    case "audit":
      return (
        <Chrome tone="score" bare>
          <div className="audit">
            <div className="packet wide">
              <div className="packet-top">
                <span>Audit trail</span>
                <StatusPill tone="green">immutable</StatusPill>
              </div>
              {["target profile", "session events", "oracle adapter", "payload hash"].map((item) => (
                <div className="audit-row" key={item}>{item}<strong>recorded</strong></div>
              ))}
            </div>
          </div>
        </Chrome>
      );
    case "approval":
      return (
        <Chrome portrait>
          <div className="approval">
            <div className="reply">
              <span>Agent Bounty drafted this reply</span>
              <p>Verdict reproduced. The run seeded a fresh canary, passed the negative control, ran the submitted PoC, and the external oracle observed the canary.</p>
              <div><button>Deny</button><button className="primary">Approve</button></div>
            </div>
            <div>
              <div className="eyebrow">Human gate</div>
              <h2>The exact words get signed.</h2>
            </div>
          </div>
        </Chrome>
      );
    case "delivery":
      return (
        <Chrome>
          <div className="delivery">
            <div>
              <div className="eyebrow">Delivery</div>
              <h2>One approved comment. Replays do nothing.</h2>
              <p>The worker mints a short-lived installation token, posts the approved verdict, then ignores exact replays.</p>
            </div>
            <div className="delivered-card">
              <img src="assets/mascot-delivered.svg" />
              <strong>Delivered</strong>
              <span>GitHub comment 584b033799</span>
              <small>approved hash matched</small>
            </div>
          </div>
        </Chrome>
      );
    default:
      return null;
  }
}

function mountRecordingComponents() {
  document.querySelectorAll("[data-bd-shot]").forEach((host) => {
    const id = host.getAttribute("data-bd-shot");
    flushSync(() => {
      createRoot(host).render(<Shot id={id} />);
    });
  });
}

let mounted = false;
function mountOnce() {
  if (mounted) return;
  mounted = true;
  mountRecordingComponents();
}

window.__mountRecordingComponents = mountOnce;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOnce, { once: true });
} else {
  mountOnce();
}
