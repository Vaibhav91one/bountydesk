import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

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

function Chrome({ children, tone = "dark", bare = false }) {
  return <div className={`bd-chrome ${tone}${bare ? " bare" : ""}`}>{children}</div>;
}

function HeroButton({ children, primary = false }) {
  return <button className={`landing-button ${primary ? "primary" : ""}`}>{children}</button>;
}

function ApprovalPanel() {
  return (
    <div className="landing-approval-panel">
      <div className="landing-approval-heading">
        <span className="approval-badge">Awaiting approval</span>
        <h2>Auth bypass via SQL injection on login</h2>
      </div>

      <div className="landing-reply">
        <img src="assets/mascot-canary-found.svg" alt="" />
        <div>
          <p className="reply-author"><strong>Agent Bounty</strong> drafted this reply</p>
          <p>
            <strong>Verdict: analysis only.</strong> BountyDesk could not reproduce this report
            automatically, so no reproduced verdict was produced. A reviewer read the report and
            the run&apos;s own event log and is signing this reply by hand.
          </p>
          <p className="signed"><img src="assets/logo-small.svg" alt="" /> Signed via BountyDesk.</p>
        </div>
      </div>

      <div className="landing-meta-row">
        <span>Bound target</span>
        <strong>juice-shop-v17.3.0</strong>
      </div>
      <div className="landing-meta-row">
        <span>Content hash</span>
        <strong>30e7597fc122c1c7ad3a6bc97e70f984</strong>
      </div>
      <div className="landing-actions">
        <button>Deny</button>
        <button className="primary">Approve</button>
      </div>
    </div>
  );
}

function LandingScroll() {
  return (
    <Chrome bare>
      <div className="landing-viewport">
      <div className="landing-scroll-content" data-layout-allow-overflow="">
          <section className="landing-hero">
            <header className="landing-site-header">
              <span className="landing-logo-lockup">
                <img src="assets/logo-small.svg" alt="" />
                <span>BountyDesk</span>
              </span>
              <nav>
                <span>How it works</span>
                <span>FAQ</span>
              </nav>
            </header>

            <div className="landing-hero-copy">
              <h1>
                <span>Read every report.</span>
                <span>Sign every verdict.</span>
              </h1>
              <p>Every report authenticated and scope-checked. No verdict ships until you sign it.</p>
              <div className="landing-hero-actions">
                <HeroButton primary>Get started</HeroButton>
                <HeroButton>Star on GitHub</HeroButton>
              </div>
            </div>

            <div className="landing-backdrop" data-layout-allow-overflow="" />
          </section>

          <section className="landing-panel-section">
            <div data-layout-allow-overflow="">
              <ApprovalPanel />
            </div>
          </section>
        </div>
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
      return <LandingScroll />;
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
