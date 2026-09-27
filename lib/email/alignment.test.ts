import assert from "node:assert/strict";
import test from "node:test";

import { aligned, checkFromAlignment, organisationalDomain, parseAuthenticationResults } from "./alignment";

/**
 * A raw header block in the shape Amazon SES (Resend's receiving MX) produced for real inbound
 * Gmail mail, with addresses, IPs and signatures replaced. `ses` is the receiving MX's own
 * Authentication-Results; `sender` is whatever the sending side put in its own headers.
 */
function message(opts: { ses?: string | null; sender?: string[]; receipt?: boolean; from: string }): string {
  const lines = [
    "Return-Path: <bounce@envelope.test>",
    "Received: from mail.example (mail.example [192.0.2.1])",
    " by inbound-smtp.ap-northeast-1.amazonaws.com with SMTP id abc",
    "X-SES-Spam-Verdict: PASS",
    "X-SES-Virus-Verdict: PASS",
    "Received-SPF: pass (spfCheck: domain of example designates 192.0.2.1 as permitted sender) client-ip=192.0.2.1;",
  ];
  if (opts.ses !== null) lines.push(`Authentication-Results: ${opts.ses}`);
  if (opts.receipt !== false) lines.push("X-SES-RECEIPT: AEFBQUFBQUFB", "X-SES-DKIM-SIGNATURE: a=rsa-sha256; b=<sig>");
  lines.push("Received: by 2002:a05:6a10::1 with SMTP id x;", ...(opts.sender ?? []));
  lines.push("MIME-Version: 1.0", `From: "Someone" <${opts.from}>`, "Subject: report", "", "body text");
  return lines.join("\r\n");
}

// The real SES shape, folded across lines as SES writes it.
const GMAIL_SES =
  "amazonses.com;\r\n spf=pass (spfCheck: domain of _spf.google.com designates 192.0.2.1 as permitted sender)\r\n client-ip=192.0.2.1; envelope-from=someone@gmail.com; helo=mail.google.com;\r\n dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com;";

test("an aligned gmail.com message is accepted", () => {
  const verdict = checkFromAlignment(message({ ses: GMAIL_SES, from: "someone@gmail.com" }), "gmail.com");
  assert.deepEqual(verdict, { ok: true, via: "dmarc" });
});

test("a forged From with attacker.com SPF and DKIM passing is refused", () => {
  const ses =
    "amazonses.com; spf=pass (spfCheck: ok) client-ip=192.0.2.9; envelope-from=x@attacker.com; helo=attacker.com; dkim=pass header.i=@attacker.com; dmarc=fail header.from=bigcorp.com;";
  const verdict = checkFromAlignment(message({ ses, from: "victim@bigcorp.com" }), "bigcorp.com");
  assert.equal(verdict.ok, false);
});

test("a DMARC pass for another domain does not vouch for this From", () => {
  const ses = "amazonses.com; dkim=pass header.i=@attacker.com; dmarc=pass header.from=attacker.com;";
  assert.equal(checkFromAlignment(message({ ses, from: "victim@bigcorp.com" }), "bigcorp.com").ok, false);
});

test("a subdomain aligns under relaxed matching, including under a two-part suffix", () => {
  const ses = "amazonses.com; dkim=pass header.d=example.co.uk header.s=s1; dmarc=none header.from=mail.example.co.uk;";
  assert.deepEqual(
    checkFromAlignment(message({ ses, from: "sec@mail.example.co.uk" }), "mail.example.co.uk"),
    { ok: true, via: "dkim" },
  );
  assert.equal(aligned("mail.bigcorp.com", "bigcorp.com"), true);
  assert.equal(aligned("example.co.uk", "other.co.uk"), false);
  assert.equal(organisationalDomain("a.b.example.com.au"), "example.com.au");
});

test("missing headers are refused", () => {
  assert.equal(checkFromAlignment("", "gmail.com").ok, false);
  assert.equal(checkFromAlignment(message({ ses: null, from: "someone@gmail.com" }), "gmail.com").ok, false);
  assert.equal(
    checkFromAlignment(message({ ses: GMAIL_SES, receipt: false, from: "someone@gmail.com" }), "gmail.com").ok,
    false,
    "without the MX's receipt there is no way to tell its result from a sender's",
  );
});

test("a spoofed Authentication-Results below the receiving MX's own is ignored", () => {
  const ses = "amazonses.com; spf=pass envelope-from=x@attacker.com; dkim=pass header.i=@attacker.com; dmarc=fail header.from=bigcorp.com;";
  const forged = "Authentication-Results: amazonses.com; dkim=pass header.d=bigcorp.com; dmarc=pass header.from=bigcorp.com;";
  assert.equal(
    checkFromAlignment(message({ ses, sender: [forged], from: "victim@bigcorp.com" }), "bigcorp.com").ok,
    false,
  );

  // With no result from the MX at all, a forged one (even with its own fake receipt) is still
  // below the real receipt and is never read.
  assert.equal(
    checkFromAlignment(
      message({ ses: null, sender: [forged, "X-SES-RECEIPT: forged"], from: "victim@bigcorp.com" }),
      "bigcorp.com",
    ).ok,
    false,
  );
});

test("a result from another authserv-id is not trusted", () => {
  const ses = "mx.attacker.com; dmarc=pass header.from=bigcorp.com;";
  assert.equal(checkFromAlignment(message({ ses, from: "victim@bigcorp.com" }), "bigcorp.com").ok, false);
});

test("comments and folded properties parse into method results", () => {
  const parsed = parseAuthenticationResults(GMAIL_SES.replace(/\r\n /g, " "));
  assert.equal(parsed.authservId, "amazonses.com");
  assert.deepEqual(
    parsed.results.map((r) => `${r.method}=${r.result}`),
    ["spf=pass", "dkim=pass", "dmarc=pass"],
  );
  assert.equal(parsed.results[2].props["header.from"], "gmail.com");
});
