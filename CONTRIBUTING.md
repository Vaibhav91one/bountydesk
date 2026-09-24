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
`.github/workflows/ci.yml` runs install, lint, migrations, schema-drift checks, the application tests, the Claude review policy tests, and the production build on every PR. Keep the `build` check green; it is the only required automated status check.

The `Claude review` workflow adds advisory findings to a same-repository PR when it opens and when a member comments `/review`. It is not a required check and does not replace human review: address each finding or reply in its thread with the reason it does not apply. Fork PRs are not reviewed. If the review fails or is missing, human review plus the green `build` check can still complete a merge. See `docs/claude-review.md`.
