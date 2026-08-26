# Contributing to BountyDesk

## Ground rules
1. **PRs only.** Nothing lands on `main` without a pull request — direct pushes are blocked by branch protection.
2. **Qodo reviews every PR.** Address what Qodo Merge finds before merge, or reply explaining why a finding does not apply. Re-run `/review` after changes.
3. **Security changes need tests + a note.** Anything touching scope enforcement, the approval / `publish_verdict` gate, delivery / outbox, or GitHub App connectivity needs tests in the PR and a sentence in the description about the threat model.
4. **No secrets.** Keys live in the environment / `.env` (gitignored), never committed. The GitHub App webhook secret is platform-owned.
5. **Disclose AI assistance** in the PR description when AI tooling wrote substantial code.

## Workflow
```bash
git checkout -b <type>/<short-description>   # feat/… fix/… chore/…
# make changes
git commit -m "type: imperative subject"
git push -u origin HEAD
gh pr create                                 # Qodo auto-reviews; address; then merge
```

## CI
`.github/workflows/ci.yml` runs install, lint, tests when a test script exists, and build on every PR.
`.github/workflows/qodo-review.yml` verifies that Qodo reviewed the current PR head commit, not an
older revision. Keep both `build` and `qodo-reviewed` green; once the Qodo workflow has landed and
reported its first status, both contexts must be required by `main` branch protection.
