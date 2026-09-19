# Contributing to BountyDesk

## Ground rules
1. **PRs only.** Nothing lands on `main` without a pull request. Direct pushes are blocked by branch protection.
2. **PRs are reviewed before merge.** Address what a review finds, or reply explaining why a finding does not apply.
3. **Security changes need tests + a note.** Anything touching scope enforcement, the agent's own sandboxed tool use against scope-guard, the approval / `publish_verdict` gate (including its draft-validation and authorization-recheck path), delivery / outbox, or GitHub App connectivity needs tests in the PR and a sentence in the description about the threat model.
4. **No secrets.** Keys live in the environment / `.env` (gitignored), never committed. The GitHub App webhook secret is platform-owned.
5. **Disclose material AI assistance generically** in the PR description, without naming or tagging a tool, adding a bot co-author trailer, or adding generated-credit language.
6. **Write like a person.** Comments, commit messages, PR descriptions and docs should read as though a human wrote them: plain verbs, no em dashes, no emoji or bolded mini-headings, headings in sentence case. Comments say why, not what. Agents working in this repo run the `humanizer` skill over prose before committing it. See the writing style section in [AGENTS.md](./AGENTS.md).

## Workflow
```bash
git checkout -b <type>/<short-description>   # feat/… fix/… chore/…
# make changes
git commit -m "type: imperative subject"
git push -u origin HEAD
gh pr create                                 # review the diff, then merge
```

## CI
`.github/workflows/ci.yml` runs install, lint, migrations, schema-drift checks, the application tests, the PR-Agent verifier tests, and the production build on every PR. Keep the `build` check green; it is the only required automated status check.

PR-Agent may add advisory findings to a same-repository PR. Neither `PR Agent review` nor `Verify PR Agent review` is a required check, and neither replaces human review. Address findings or explain why they do not apply. Treat the PR-Agent review as current only when the publication check in `docs/pr-agent-review.md` returns `VERIFIED` or `NO_FINDINGS` for the current head. Fork PRs intentionally skip provider-backed review. If the provider or publication check fails after its bounded retries, human review plus the green `build` check can still complete a merge, but the PR must not be described as PR-Agent verified. Fixture tests prove the parser in CI; only a live run with its canary evidence proves a PR. Live review needs the approved provider and data binding in `docs/pr-agent-review.md`, stays within the two attempts per head SHA plus the verifier's bounded API retries, and keeps the current limitations there.
