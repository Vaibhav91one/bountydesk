import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CheckCircle2,
  CircleDashed,
  FileCheck2,
  Fingerprint,
  GitBranch,
  LockKeyhole,
  MessagesSquare,
  Network,
  PackageCheck,
  Send,
  ShieldCheck,
  Signature,
  TerminalSquare,
} from "lucide-react";

export const FPS = 30;
export const DURATION_IN_FRAMES = 1440;

const palette = {
  bg: "#121213",
  panel: "#1f1f21",
  panel2: "#18181a",
  line: "rgba(245,245,245,0.1)",
  text: "#f5f5f5",
  muted: "rgba(245,245,245,0.62)",
  faint: "rgba(245,245,245,0.38)",
  brand: "#6774f0",
  brandSoft: "#b8b8ff",
  cyan: "#65d7d0",
  amber: "#f4c76b",
  green: "#68d391",
  magenta: "#e879f9",
} as const;

const scenes = [
  { start: 0, duration: 150 },
  { start: 140, duration: 170 },
  { start: 300, duration: 190 },
  { start: 480, duration: 210 },
  { start: 680, duration: 200 },
  { start: 870, duration: 210 },
  { start: 1070, duration: 220 },
  { start: 1280, duration: 160 },
] as const;

const reports = [
  {
    title: "SQL injection in /rest/products/search",
    id: "#175152",
    state: "Reproducing",
    tone: palette.cyan,
    mascot: "mascot/reproducing.svg",
  },
  {
    title: "Auth bypass via SQL injection on login",
    id: "#175156",
    state: "Awaiting approval",
    tone: palette.amber,
    mascot: "mascot/awaiting-approval.svg",
  },
  {
    title: "Directory traversal in upload handler",
    id: "#175154",
    state: "Delivered",
    tone: palette.green,
    mascot: "mascot/delivered.svg",
  },
  {
    title: "Missing headers on marketing site",
    id: "#175155",
    state: "Out of scope",
    tone: palette.faint,
    mascot: "mascot/out-of-scope.svg",
  },
];

const stageRows = [
  ["GitHub App", "Signed issue delivery"],
  ["Target profile", "Vaibhav91one/juice-shop @ v17.3.0"],
  ["Scope guard", "Server-bound repo and commit"],
  ["Job queue", "Leased worker, durable state"],
];

const sandboxNodes = [
  { label: "Repo", detail: "Exact commit", x: 190, y: 210, icon: GitBranch },
  { label: "Controller", detail: "BountyDesk", x: 710, y: 210, icon: ShieldCheck },
  { label: "Build sandbox", detail: "Dependency egress", x: 190, y: 470, icon: PackageCheck },
  { label: "Offline runtime", detail: "Pinned target", x: 710, y: 470, icon: LockKeyhole },
  { label: "PoC runner", detail: "Sandbox-localhost", x: 190, y: 730, icon: TerminalSquare },
  { label: "Oracle", detail: "Canary check", x: 710, y: 730, icon: Fingerprint },
];

function ease(frame: number, input: [number, number], output: [number, number]) {
  return interpolate(frame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

function useSceneProgress(start: number, duration: number) {
  const frame = useCurrentFrame();
  const local = frame - start;
  const enter = ease(local, [0, 24], [0, 1]);
  const exit = ease(local, [duration - 22, duration], [1, 0]);
  return { local, visible: Math.min(enter, exit) };
}

function useBeat(offset = 0) {
  const frame = useCurrentFrame();
  return Math.sin((frame + offset) / 18) * 0.5 + 0.5;
}

function Backdrop({ asset, drift = 20 }: { asset: string; drift?: number }) {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, DURATION_IN_FRAMES], [1.04, 1.1]);
  const y = interpolate(frame, [0, DURATION_IN_FRAMES], [-drift, drift]);
  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg, overflow: "hidden" }}>
      <Img
        src={staticFile(asset)}
        style={{
          position: "absolute",
          inset: -60,
          width: 2040,
          height: 1200,
          objectFit: "cover",
          opacity: 0.28,
          transform: `translateY(${y}px) scale(${scale})`,
          filter: "saturate(0.72) contrast(1.08)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(18,18,19,0.95), rgba(18,18,19,0.76) 42%, rgba(18,18,19,0.92))",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(rgba(245,245,245,0.08) 1px, transparent 1px)",
          backgroundSize: "36px 36px",
          opacity: 0.25,
        }}
      />
    </AbsoluteFill>
  );
}

function BrandChrome() {
  return (
    <>
      <Img
        src={staticFile("logo-lockup.svg")}
        style={{
          position: "absolute",
          left: 78,
          top: 58,
          width: 260,
          height: "auto",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 78,
          top: 62,
          color: palette.faint,
          fontSize: 18,
          fontWeight: 400,
          letterSpacing: 0,
        }}
      >
        automated bug bounty triage
      </div>
    </>
  );
}

function Headline({
  kicker,
  title,
  body,
  start,
  wide = false,
}: {
  kicker: string;
  title: string;
  body: string;
  start: number;
  wide?: boolean;
}) {
  const frame = useCurrentFrame();
  const y = ease(frame - start, [0, 28], [42, 0]);
  const opacity = ease(frame - start, [0, 24], [0, 1]);
  return (
    <div style={{ transform: `translateY(${y}px)`, opacity }}>
      <div
        style={{
          color: palette.brandSoft,
          fontSize: 20,
          fontWeight: 400,
          letterSpacing: 0,
          marginBottom: 22,
        }}
      >
        {kicker}
      </div>
      <h1
        style={{
          color: palette.text,
          fontSize: wide ? 96 : 82,
          lineHeight: 0.98,
          fontWeight: 400,
          letterSpacing: 0,
          maxWidth: wide ? 1120 : 860,
          margin: 0,
        }}
      >
        {title}
      </h1>
      <p
        style={{
          color: palette.muted,
          fontSize: 29,
          lineHeight: 1.45,
          maxWidth: wide ? 900 : 760,
          marginTop: 28,
          marginBottom: 0,
          fontWeight: 400,
        }}
      >
        {body}
      </p>
    </div>
  );
}

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: `1px solid ${palette.line}`,
        background: "rgba(31,31,33,0.88)",
        borderRadius: 18,
        boxShadow: "0 30px 80px rgba(0,0,0,0.38)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  children,
  tone = palette.brand,
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 999,
        background: `${tone}24`,
        color: tone,
        border: `1px solid ${tone}42`,
        padding: "8px 13px",
        fontSize: 17,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SceneFrame({
  children,
  start,
  duration,
  backdrop,
  label,
}: {
  children: React.ReactNode;
  start: number;
  duration: number;
  backdrop: string;
  label: string;
}) {
  const { visible } = useSceneProgress(start, duration);
  const scale = interpolate(visible, [0, 1], [0.985, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        opacity: visible,
        transform: `scale(${scale})`,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}
    >
      <Backdrop asset={backdrop} />
      <BrandChrome />
      {children}
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 58,
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "center",
          gap: 24,
        }}
      >
        <span
          style={{
            height: 2,
            background: palette.brand,
            opacity: 0.72,
            transform: `scaleX(${visible})`,
            transformOrigin: "left center",
          }}
        />
        <span
          style={{
            color: palette.faint,
            fontSize: 17,
            fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
            letterSpacing: 1.4,
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      </div>
    </AbsoluteFill>
  );
}

function IntroScene() {
  const scene = scenes[0];
  const { local } = useSceneProgress(scene.start, scene.duration);
  const beat = useBeat();
  const mascotY = interpolate(beat, [0, 1], [-8, 8]);
  const ring = ease(local, [24, 80], [0, 1]);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/hero.webp"
      label="claim to evidence"
    >
      <div style={{ position: "absolute", left: 150, top: 252 }}>
        <Headline
          kicker="Demo run"
          title="Bug reports are claims. Verdicts need evidence."
          body="BountyDesk turns a signed report into a canary-checked evidence packet, then waits for a human to approve the exact words."
          start={scene.start + 8}
          wide
        />
      </div>
      <div
        style={{
          position: "absolute",
          right: 210,
          top: 260,
          width: 460,
          height: 460,
          transform: `translateY(${mascotY}px)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 34,
            borderRadius: 999,
            border: `2px solid rgba(103,116,240,${0.15 + ring * 0.4})`,
            transform: `scale(${0.86 + ring * 0.24})`,
          }}
        />
        <Img src={staticFile("trix.svg")} style={{ width: "100%", height: "100%" }} />
      </div>
    </SceneFrame>
  );
}

function IntakeScene() {
  const scene = scenes[1];
  const { local } = useSceneProgress(scene.start, scene.duration);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/panel.webp"
      label="signed intake"
    >
      <div style={{ position: "absolute", left: 128, top: 185 }}>
        <Headline
          kicker="1. Intake"
          title="Identity is not repo access."
          body="OAuth identifies the user. The GitHub App grants the repo. The server binds the issue to the target profile."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 130,
          top: 188,
          width: 620,
          padding: 28,
        }}
      >
        {stageRows.map(([label, value], index) => {
          const reveal = ease(local, [48 + index * 14, 70 + index * 14], [0, 1]);
          return (
            <div
              key={label}
              style={{
                opacity: reveal,
                transform: `translateY(${(1 - reveal) * 20}px)`,
                display: "flex",
                justifyContent: "space-between",
                gap: 24,
                padding: "22px 0",
                borderBottom: index === stageRows.length - 1 ? "none" : `1px solid ${palette.line}`,
              }}
            >
              <span style={{ color: palette.muted, fontSize: 21 }}>{label}</span>
              <span
                style={{
                  color: palette.text,
                  fontSize: 21,
                  maxWidth: 340,
                  textAlign: "right",
                  lineHeight: 1.35,
                }}
              >
                {value}
              </span>
            </div>
          );
        })}
      </Card>
    </SceneFrame>
  );
}

function QueueScene() {
  const scene = scenes[2];
  const { local } = useSceneProgress(scene.start, scene.duration);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/queue.webp"
      label="queue states"
    >
      <div style={{ position: "absolute", left: 110, right: 110, top: 152 }}>
        <Headline
          kicker="2. Triage queue"
          title="Every report has a state. None has a guess."
          body="The console shows where work is, what needs review, and which outcomes are terminal."
          start={scene.start + 4}
          wide
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 110,
          right: 110,
          bottom: 86,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 18,
        }}
      >
        {reports.map((report, index) => {
          const reveal = spring({
            frame: Math.max(0, local - 46 - index * 9),
            fps: FPS,
            config: { damping: 18, stiffness: 90 },
          });
          const active = local > 92 + index * 12;
          return (
            <Card
              key={report.id}
              style={{
                minHeight: 276,
                padding: 24,
                opacity: reveal,
                transform: `translateY(${(1 - reveal) * 44}px)`,
                borderColor: active ? `${report.tone}88` : palette.line,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 18 }}>
                <div>
                  <Pill tone={report.tone}>{report.state}</Pill>
                  <h3
                    style={{
                      margin: "24px 0 12px",
                      color: palette.text,
                      fontSize: 25,
                      lineHeight: 1.22,
                      letterSpacing: 0,
                      fontWeight: 400,
                    }}
                  >
                    {report.title}
                  </h3>
                  <p style={{ margin: 0, color: palette.muted, fontSize: 18 }}>
                    {report.id} · juice-shop-v17.3.0
                  </p>
                </div>
                <Img src={staticFile(report.mascot)} style={{ width: 92, height: 92 }} />
              </div>
            </Card>
          );
        })}
      </div>
    </SceneFrame>
  );
}

function SandboxScene() {
  const scene = scenes[3];
  const { local } = useSceneProgress(scene.start, scene.duration);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/reports.webp"
      label="isolated reproduction"
    >
      <div style={{ position: "absolute", left: 120, top: 156, width: 650 }}>
        <Headline
          kicker="3. Reproduction"
          title="A green script is not reproduction."
          body="The run boots a pinned target offline, seeds a fresh canary, runs a negative control, then executes the PoC."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 100,
          top: 118,
          width: 980,
          height: 850,
          padding: 34,
          background: "rgba(24,24,26,0.86)",
        }}
      >
        <svg width="912" height="770" viewBox="0 0 912 770" style={{ position: "absolute" }}>
          {[
            [320, 250],
            [320, 510],
            [580, 250],
            [320, 770],
            [580, 510],
            [580, 250],
          ].map(([x2, y2], index) => {
            const from = sandboxNodes[index];
            const reveal = ease(local, [50 + index * 10, 80 + index * 10], [0, 1]);
            return (
              <line
                key={`${from.label}-${index}`}
                x1={from.x + 150}
                y1={from.y + 34}
                x2={x2}
                y2={y2 - 226}
                stroke={palette.brand}
                strokeWidth={3}
                strokeDasharray="10 12"
                opacity={reveal * 0.55}
              />
            );
          })}
        </svg>
        {sandboxNodes.map((node, index) => {
          const Icon = node.icon;
          const reveal = spring({
            frame: Math.max(0, local - 24 - index * 8),
            fps: FPS,
            config: { damping: 20, stiffness: 100 },
          });
          return (
            <div
              key={node.label}
              style={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: 300,
                padding: 20,
                borderRadius: 16,
                border: `1px solid ${palette.line}`,
                background: palette.panel,
                opacity: reveal,
                transform: `translateY(${(1 - reveal) * 30}px)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, color: palette.brandSoft }}>
                <Icon size={24} />
                <span style={{ fontSize: 18, fontWeight: 400 }}>{node.label}</span>
              </div>
              <p style={{ margin: "12px 0 0", color: palette.text, fontSize: 25 }}>
                {node.detail}
              </p>
            </div>
          );
        })}
      </Card>
    </SceneFrame>
  );
}

function OracleScene() {
  const scene = scenes[4];
  const { local } = useSceneProgress(scene.start, scene.duration);
  const pulse = useBeat(12);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/panel.webp"
      label="canary oracle"
    >
      <div style={{ position: "absolute", left: 126, top: 180, width: 760 }}>
        <Headline
          kicker="4. Canary oracle"
          title="The canary decides."
          body="The model can read logs and HTTP text. It cannot declare reproduction. The oracle runs outside the sandbox."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 132,
          top: 222,
          width: 650,
          padding: 34,
        }}
      >
        {[
          { label: "Negative control", value: "Passed", tone: palette.green, icon: CircleDashed },
          { label: "Fresh canary", value: "Seeded per run", tone: palette.brandSoft, icon: Fingerprint },
          { label: "PoC execution", value: "Sandbox-localhost", tone: palette.cyan, icon: TerminalSquare },
          { label: "External oracle", value: "Canary observed", tone: palette.green, icon: CheckCircle2 },
        ].map(({ label, value, tone, icon: Icon }, index) => {
          const reveal = ease(local, [32 + index * 18, 54 + index * 18], [0, 1]);
          return (
            <div
              key={label}
              style={{
                display: "grid",
                gridTemplateColumns: "44px 1fr auto",
                alignItems: "center",
                gap: 18,
                padding: "20px 0",
                borderBottom: index === 3 ? "none" : `1px solid ${palette.line}`,
                opacity: reveal,
                transform: `translateX(${(1 - reveal) * 26}px)`,
              }}
            >
              <Icon size={30} color={tone} style={{ transform: `scale(${1 + pulse * 0.06})` }} />
              <span style={{ color: palette.text, fontSize: 24 }}>{label}</span>
              <span style={{ color: tone, fontSize: 19, fontWeight: 600 }}>{value}</span>
            </div>
          );
        })}
      </Card>
    </SceneFrame>
  );
}

function PacketScene() {
  const scene = scenes[5];
  const { local } = useSceneProgress(scene.start, scene.duration);
  const typed = "booted pinned image -> seeded canary -> negative control passed -> ran PoC -> oracle observed canary";
  const chars = Math.floor(ease(local, [42, 124], [0, typed.length]));
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/reports.webp"
      label="evidence packet"
    >
      <div style={{ position: "absolute", left: 126, top: 170, width: 720 }}>
        <Headline
          kicker="5. Evidence packet"
          title="Show the reviewer what happened."
          body="The raw PoC stays labeled as unverified input. Trusted evidence comes from BountyDesk's run log and oracle."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 130,
          top: 150,
          width: 720,
          padding: 34,
          background: "#f5f5f5",
          color: "#121213",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <FileCheck2 size={34} color={palette.brand} />
            <div>
              <div style={{ fontSize: 28, fontWeight: 400 }}>Evidence packet</div>
              <div style={{ fontSize: 17, color: "rgba(18,18,19,0.58)" }}>report beabb524</div>
            </div>
          </div>
          <Pill tone={palette.green}>REPRODUCED</Pill>
        </div>
        <div
          style={{
            marginTop: 34,
            borderRadius: 14,
            background: "#121213",
            color: "#d7defe",
            padding: 24,
            minHeight: 190,
            fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 21,
            lineHeight: 1.5,
          }}
        >
          {typed.slice(0, chars)}
          <span style={{ opacity: Math.floor(local / 12) % 2 ? 0 : 1 }}>_</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 22 }}>
          <MiniFact label="Content hash" value="30e7597fc122c1c7ad3a6bc97e70f984" />
          <MiniFact label="Delivery" value="pending human approval" />
        </div>
      </Card>
    </SceneFrame>
  );
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid rgba(18,18,19,0.12)", borderRadius: 12, padding: 16 }}>
      <div style={{ color: "rgba(18,18,19,0.55)", fontSize: 15, marginBottom: 8 }}>{label}</div>
      <div style={{ color: "#121213", fontSize: 17, lineHeight: 1.28, wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}

function ApprovalScene() {
  const scene = scenes[6];
  const { local } = useSceneProgress(scene.start, scene.duration);
  const sign = ease(local, [92, 124], [0, 1]);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/hero.webp"
      label="human approval"
    >
      <div style={{ position: "absolute", left: 120, top: 160, width: 760 }}>
        <Headline
          kicker="6. Human gate"
          title="The exact words get signed."
          body="publish_verdict refuses a changed payload. Similar reports go to a reviewer. Exact delivery replays are no-ops."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 118,
          top: 150,
          width: 760,
          padding: 30,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <Img src={staticFile("mascot/awaiting-approval.svg")} style={{ width: 76, height: 76 }} />
          <div>
            <Pill tone={palette.amber}>Awaiting approval</Pill>
            <h3
              style={{
                margin: "14px 0 0",
                color: palette.text,
                fontSize: 27,
                fontWeight: 400,
              }}
            >
              Agent Bounty drafted this reply
            </h3>
          </div>
        </div>
        <div
          style={{
            border: `1px solid ${palette.line}`,
            borderRadius: 14,
            padding: 24,
            color: palette.text,
            fontSize: 23,
            lineHeight: 1.45,
            background: palette.panel2,
          }}
        >
          Verdict: reproduced. The run seeded a fresh canary, passed the negative control, ran
          the submitted PoC, and the external oracle observed the canary in the trusted sink.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 14, marginTop: 24 }}>
          <button style={buttonStyle("ghost")}>Deny</button>
          <button style={buttonStyle("primary")}>
            <Signature size={22} />
            Approve
          </button>
        </div>
        <div
          style={{
            position: "absolute",
            right: 48,
            bottom: 40,
            height: 4,
            width: 220 * sign,
            borderRadius: 999,
            background: palette.green,
          }}
        />
      </Card>
    </SceneFrame>
  );
}

function buttonStyle(kind: "ghost" | "primary"): React.CSSProperties {
  return {
    height: 48,
    borderRadius: 10,
    border: kind === "primary" ? "none" : `1px solid ${palette.line}`,
    background: kind === "primary" ? palette.brand : "transparent",
    color: palette.text,
    padding: "0 20px",
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    fontSize: 18,
    fontWeight: 650,
  };
}

function DeliveryScene() {
  const scene = scenes[7];
  const { local } = useSceneProgress(scene.start, scene.duration);
  const done = ease(local, [46, 90], [0, 1]);
  return (
    <SceneFrame
      start={scene.start}
      duration={scene.duration}
      backdrop="backdrop/queue.webp"
      label="approved delivery"
    >
      <div style={{ position: "absolute", left: 130, top: 205 }}>
        <Headline
          kicker="7. Delivery"
          title="One approved comment. Replays do nothing."
          body="The worker mints a short-lived installation token, posts the approved verdict, discards the token, and ignores exact replays."
          start={scene.start + 4}
        />
      </div>
      <Card
        style={{
          position: "absolute",
          right: 150,
          top: 250,
          width: 560,
          padding: 32,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 92,
              height: 92,
              borderRadius: 999,
              background: `${palette.green}24`,
              display: "grid",
              placeItems: "center",
              transform: `scale(${0.86 + done * 0.14})`,
            }}
          >
            <Send size={42} color={palette.green} />
          </div>
          <div>
            <div style={{ color: palette.text, fontSize: 31, fontWeight: 400 }}>Delivered</div>
            <div style={{ color: palette.muted, fontSize: 20, marginTop: 8 }}>
              GitHub comment 5464633799
            </div>
          </div>
        </div>
        <div style={{ marginTop: 34, display: "grid", gap: 14 }}>
          <FinalRow icon={CheckCircle2} label="Approved hash matched" active={local > 70} />
          <FinalRow icon={MessagesSquare} label="Reporter sees the verdict" active={local > 88} />
          <FinalRow icon={Network} label="Duplicate webhook replay ignored" active={local > 106} />
        </div>
      </Card>
    </SceneFrame>
  );
}

function FinalRow({
  icon: Icon,
  label,
  active,
}: {
  icon: typeof CheckCircle2;
  label: string;
  active: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        color: active ? palette.text : palette.faint,
        fontSize: 21,
      }}
    >
      <Icon size={24} color={active ? palette.green : palette.faint} />
      {label}
    </div>
  );
}

function AudioBed() {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <>
      <Audio
        src={staticFile("demo-audio/bountydesk-lofi.mp3")}
        loop
        volume={(frame) =>
          interpolate(
            frame,
            [0, fps * 1.5, durationInFrames - fps * 2.2, durationInFrames],
            [0, 0.19, 0.19, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
      {[140, 300, 480, 680, 870, 1070, 1280].map((from, index) => (
        <Sequence key={from} from={from - 4}>
          <Audio
            src={staticFile(index % 2 === 0 ? "demo-audio/whoosh-a.wav" : "demo-audio/whoosh-b.wav")}
            volume={0.18}
          />
        </Sequence>
      ))}
      {[990, 1370].map((from) => (
        <Sequence key={from} from={from}>
          <Audio src={staticFile("demo-audio/ping.wav")} volume={0.12} />
        </Sequence>
      ))}
    </>
  );
}

export function BountyDeskDemo() {
  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      <IntroScene />
      <IntakeScene />
      <QueueScene />
      <SandboxScene />
      <OracleScene />
      <PacketScene />
      <ApprovalScene />
      <DeliveryScene />
      <AudioBed />
    </AbsoluteFill>
  );
}
