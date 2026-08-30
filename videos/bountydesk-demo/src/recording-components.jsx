import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const reports = [
  { title: "Stored XSS in the product review field", source: "#175151", state: "Triaging", phase: "triaging" },
  { title: "SQL injection in /rest/products/search", source: "#175152", state: "Reproducing", phase: "reproducing" },
  { title: "Auth bypass via SQL injection on login", source: "#175156", state: "Awaiting approval", phase: "approval" },
  { title: "Directory traversal in the file upload handler", source: "#175154", state: "Delivered", phase: "delivered" },
];

const channels = [
  { name: "GitHub", status: "Live", note: "Issues in, approved verdicts back out." },
  { name: "Email", status: "Designed", note: "Intake without a GitHub account." },
  { name: "File upload", status: "Designed", note: "Direct report packets." },
  { name: "Drive", status: "Mapped", note: "Shared folder intake." },
];

const faq = [
  ["Does reproduction run today?", "No. The sandbox topology and canary oracle are designed and not built."],
  ["How would you know a bug is real?", "A fresh canary is seeded, the negative control runs first, and an external oracle decides."],
  ["What exactly am I approving?", "The precise outbound comment, bound to a content hash."],
  ["What does the GitHub App ask for?", "Metadata read plus Issues read and write. Nothing that can write code."],
];

function Chrome({ children, tone = "dark", bare = false }) {
  return (
    <div className={`bd-chrome ${tone}${bare ? " bare" : ""}`}>
      {!bare && (
        <div className="topbar">
          <div className="traffic">
            <span />
            <span />
            <span />
          </div>
          <div className="brand-pill">
            <img src="assets/logo-small.svg" alt="" />
            <span>BountyDesk</span>
          </div>
          <div className="url">Landing page</div>
          <div className="nav-item active">Home</div>
          <div className="nav-item">How it works</div>
          <div className="nav-item">FAQ</div>
          <div className="nav-item">Sign in</div>
        </div>
      )}
      {children}
    </div>
  );
}

function StatusPill({ children, tone = "violet" }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

function TextAnimate({ children, animation = "slideUp", by = "word", className = "" }) {
  const text = String(children);
  const segments = by === "character" ? Array.from(text) : by === "word" ? text.split(/(\s+)/) : [text];
  const tokenClassName = by === "character" ? "text-animate-character" : "text-animate-word";

  return (
    <span className={`text-animate ${animation} by-${by} ${className}`} aria-hidden="true">
      {segments.map((segment, index) => {
        if (/^\s+$/.test(segment)) return segment;
        return (
          <span className={`text-animate-token ${tokenClassName}`} key={`${segment}-${index}`}>
            {segment}
          </span>
        );
      })}
    </span>
  );
}

function PhaseDot({ phase }) {
  return <span className={`phase-dot phase-${phase}`} />;
}

function LandingHero() {
  return (
    <Chrome>
      <div className="landing-hero-showcase">
        <div className="site-header-mini">
          <img src="assets/logo-small.svg" alt="" />
          <span>BountyDesk</span>
          <span>How it works</span>
          <span>FAQ</span>
        </div>
        <div className="landing-copy">
          <h1>
            <span>Read every report.</span>
            <span>Sign every verdict.</span>
          </h1>
          <p>Every report authenticated and scope-checked. No verdict ships until you sign it.</p>
          <div className="hero-actions">
            <button className="primary">Get started</button>
            <button>Star on GitHub</button>
          </div>
        </div>
        <div className="hero-panel">
          <ApprovalCard compact />
        </div>
      </div>
    </Chrome>
  );
}

function ApprovalCard({ compact = false }) {
  return (
    <div className={`approval-card ${compact ? "compact" : ""}`}>
      <div className="approval-top">
        <StatusPill tone="amber">Awaiting approval</StatusPill>
        <span>Auth bypass via SQL injection on login</span>
      </div>
      <div className="agent-reply">
        <img src="assets/mascot-canary-found.svg" alt="" />
        <div>
          <span>Agent Bounty drafted this reply</span>
          <p><strong>Verdict: analysis only.</strong> No reproduced verdict was produced. A reviewer signs the final reply by hand.</p>
        </div>
      </div>
      <div className="approval-meta">
        <span>Bound target</span>
        <strong>juice-shop-v17.3.0</strong>
      </div>
      <div className="approval-meta">
        <span>Content hash</span>
        <strong>30e7597fc122c1c7ad3a6bc97e70f984</strong>
      </div>
      <div className="approval-actions">
        <button>Deny</button>
        <button className="primary">Approve</button>
      </div>
    </div>
  );
}

function ChannelsGrid() {
  return (
    <Chrome>
      <div className="section-showcase channels-showcase">
        <section>
          <div className="eyebrow">Intake channels</div>
          <h2>Reports arrive from where they arrive.</h2>
          <p>GitHub is live. Email, uploads, and drive intake stay visible as designed channels without pretending they are shipped.</p>
        </section>
        <div className="channel-grid">
          {channels.map((channel) => (
            <div className="channel-card" key={channel.name}>
              <div>
                <div className="channel-icon">{channel.name.slice(0, 1)}</div>
                <StatusPill tone={channel.status === "Live" ? "green" : "muted"}>{channel.status}</StatusPill>
              </div>
              <strong>{channel.name}</strong>
              <span>{channel.note}</span>
            </div>
          ))}
        </div>
      </div>
    </Chrome>
  );
}

function AgentBounty() {
  return (
    <Chrome>
      <div className="agent-showcase">
        <div className="mascot-row">
          {["idle", "ingest", "scanning", "reproducing", "awaiting-approval", "delivered"].map((name) => (
            <img key={name} src={`assets/mascot-${name === "idle" ? "idle" : name === "delivered" ? "delivered" : "canary-found"}.svg`} alt="" />
          ))}
        </div>
        <section>
          <div className="eyebrow">Agent Bounty</div>
          <h2>It drafts the reply. It never decides the verdict.</h2>
          <p>The model can read, triage, and drive the run. The oracle decides whether the canary was observed, and a person signs the words.</p>
        </section>
      </div>
    </Chrome>
  );
}

function SandboxTopology() {
  return (
    <Chrome>
      <div className="section-showcase sandbox-showcase">
        <section>
          <div className="eyebrow">Reproduction</div>
          <h2>Two sandboxes, and an oracle outside both.</h2>
          <p>The build sandbox handles dependencies. The reproduction sandbox runs offline. Only the built artifact crosses between them.</p>
        </section>
        <div className="sandbox-board">
          {["Connected repo", "BountyDesk", "Build sandbox", "Target runtime", "PoC runner", "External oracle"].map((node, index) => (
            <div className={`sandbox-node n${index + 1}`} key={node}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{node}</strong>
            </div>
          ))}
          <div className="flow-line l1" />
          <div className="flow-line l2" />
          <div className="flow-line l3" />
          <div className="flow-line l4" />
        </div>
      </div>
    </Chrome>
  );
}

function QueuePreview() {
  const columns = [
    ["Triaging", reports[0]],
    ["Reproducing", reports[1]],
    ["Awaiting approval", reports[2]],
  ];
  return (
    <Chrome>
      <div className="section-showcase queue-landing-showcase">
        <section>
          <div className="eyebrow">Review queue</div>
          <h2>Work in flight, by phase.</h2>
          <p>Cards move through the same phases the console uses, so reviewers can scan what is running and what needs a signature.</p>
        </section>
        <div className="queue-columns">
          {columns.map(([label, report]) => (
            <div className="queue-column" key={label}>
              <header><PhaseDot phase={report.phase} /><span>{label}</span><small>2</small></header>
              <div className="queue-card">
                <span>{report.source}</span>
                <strong>{report.title}</strong>
                <small>juice-shop-v17.3.0</small>
              </div>
              <div className="queue-card ghost">
                <span>#175159</span>
                <strong>IDOR on the basket endpoint</strong>
                <small>juice-shop-v17.3.0</small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Chrome>
  );
}

function ReportsIndex() {
  return (
    <Chrome>
      <div className="section-showcase reports-showcase">
        <section>
          <div className="eyebrow">Reports</div>
          <h2>Everything that arrived, however it ended.</h2>
          <p>The index keeps closed work visible and lets a reviewer filter for open reports or rows waiting on them.</p>
        </section>
        <div className="reports-table">
          <div className="search-row">Search by title, issue or repository</div>
          <div className="filter-row"><span>All 7</span><span>Open 5</span><span>Waiting on me 2</span><span>Closed 2</span></div>
          {reports.map((report) => (
            <div className="table-row" key={report.title}>
              <span><PhaseDot phase={report.phase} />{report.title}</span>
              <small>{report.source} · Vaibhav91one/juice-shop</small>
              <StatusPill tone={report.phase === "delivered" ? "green" : report.phase === "approval" ? "amber" : "violet"}>{report.state}</StatusPill>
            </div>
          ))}
        </div>
      </div>
    </Chrome>
  );
}

function FaqShowcase() {
  return (
    <Chrome>
      <div className="section-showcase faq-showcase">
        <section>
          <div className="eyebrow">FAQ</div>
          <h2>Answers come from the design record.</h2>
          <p>The landing page tells a security reader exactly what is live, what is designed, and where the human gate sits.</p>
        </section>
        <div className="faq-list">
          {faq.map(([question, answer], index) => (
            <div className={`faq-item ${index === 0 ? "open" : ""}`} key={question}>
              <strong>{question}</strong>
              <p>{answer}</p>
            </div>
          ))}
        </div>
      </div>
    </Chrome>
  );
}

function FooterClose() {
  return (
    <Chrome bare>
      <div className="footer-close">
        <img src="assets/logo-small.svg" alt="" />
        <span>Bounty</span>
        <img className="mascot" src="assets/mascot-idle.svg" alt="" />
        <span>Desk</span>
        <p>Bugs, CVEs, bounties. Reproduced securely.</p>
      </div>
    </Chrome>
  );
}

function Shot({ id }) {
  switch (id) {
    case "home":
      return (
        <Chrome bare>
          <div className="problem-shot">
            <h1 aria-label="Resolve bug reports, vulnerabilities, and CVEs in an isolated sandbox.">
              <TextAnimate animation="slideUp" by="word">
                Resolve bug reports, vulnerabilities, and CVEs in an isolated sandbox.
              </TextAnimate>
            </h1>
          </div>
        </Chrome>
      );
    case "intake":
      return (
        <Chrome bare tone="intro">
          <div className="brand-intro-shot">
            <h2 aria-label="Introducing">
              <TextAnimate animation="slideLeft" by="character">
                Introducing
              </TextAnimate>
            </h2>
            <div className="brand-intro-lockup">
              <img className="brand-intro-logo" src="assets/logo-small.svg" alt="" />
              <h1 aria-label="BountyDesk">
                <TextAnimate animation="slideLeft" by="character">
                  BountyDesk
                </TextAnimate>
              </h1>
            </div>
          </div>
        </Chrome>
      );
    case "landing":
      return <LandingHero />;
    case "approval":
      return (
        <Chrome>
          <div className="section-showcase approval-showcase">
            <section>
              <div className="eyebrow">Sign the verdict</div>
              <h2>The exact words get signed.</h2>
              <p>The approval panel from the landing page centers the whole product promise: Agent Bounty drafts, a person approves.</p>
            </section>
            <ApprovalCard />
          </div>
        </Chrome>
      );
    case "channels":
      return <ChannelsGrid />;
    case "agent":
      return <AgentBounty />;
    case "sandbox":
      return <SandboxTopology />;
    case "queue":
      return <QueuePreview />;
    case "reports":
      return <ReportsIndex />;
    case "faq":
      return <FaqShowcase />;
    case "footer":
      return <FooterClose />;
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
