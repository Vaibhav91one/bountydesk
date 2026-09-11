# Contributing to BountyDesk

## Ground rules
1. **PRs only.** Nothing lands on `main` without a pull request. Direct pushes are blocked by branch protection.
2. **PRs are reviewed before merge.** Address what a review finds, or reply explaining why a finding does not apply.
3. **Security changes need tests + a note.** Anything touching scope enforcement, the agent's own sandboxed tool use against scope-guard, the approval / `publish_verdict` gate (including its draft-validation and authorization-recheck path), delivery / outbox, or GitHub App connectivity needs tests in the PR and a sentence in the description about the threat model.
4. **No secrets.** Keys live in the environment / `.env` (gitignored), never committed. The GitHub App webhook secret is platform-owned.
5. **Disclose AI assistance** in the PR description when AI tooling wrote substantial code.
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
`.github/workflows/ci.yml` runs install, lint, tests when a test script exists, and build on every PR.
Keep the `build` check green; it is required by `main` branch protection.
