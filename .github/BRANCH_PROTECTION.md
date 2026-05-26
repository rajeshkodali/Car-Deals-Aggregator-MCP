# Branch protection — recommended settings for `main`

Branch protection rules live on GitHub, not in the repo, so this file is
documentation rather than checked-in config. Apply once after the first
`git push`.

## Required checks

The CI workflow names that should be marked **required** before merging:

| Workflow / job          | Source file                         |
|-------------------------|-------------------------------------|
| `tests (node 20)`       | `.github/workflows/ci.yml`          |
| `tests (node 22)`       | `.github/workflows/ci.yml`          |
| `lint`                  | `.github/workflows/ci.yml`          |
| `npm audit`             | `.github/workflows/ci.yml`          |
| `CodeQL`                | `.github/workflows/codeql.yml`      |
| `semgrep`               | `.github/workflows/semgrep.yml`     |

Each of these must complete successfully on the PR's head commit before
merge is allowed.

## Other rules

- **Require pull request before merging** ✅
- **Require approvals**: 1 (or 0 for solo repos — use the codeowners file
  instead)
- **Dismiss stale pull request approvals when new commits are pushed** ✅
- **Require status checks to pass before merging** ✅
- **Require branches to be up to date before merging** ✅ (forces rebase
  on stale PRs so required checks rerun against current `main`)
- **Require conversation resolution before merging** ✅
- **Require signed commits** — optional; turn on if all maintainers have
  GPG/SSH commit signing configured locally
- **Require linear history** ✅ (no merge commits — squash or rebase only)
- **Do not allow bypassing the above settings** ✅ (apply to admins too)
- **Allow force pushes** ❌
- **Allow deletions** ❌

## One-shot setup via `gh` CLI

After the first push to `main`, run from this repo's root:

```bash
gh api -X PUT "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "tests (node 20)",
      "tests (node 22)",
      "lint",
      "npm audit",
      "CodeQL",
      "semgrep"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
```

If you're the sole maintainer, set
`required_approving_review_count` to `0` — the other gates (CI, CodeQL,
Semgrep, audit) still apply.

## Verifying the rule is live

```bash
gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection" \
  | jq '{checks: .required_status_checks.contexts, linear: .required_linear_history.enabled, force: .allow_force_pushes.enabled}'
```

Expected output: the 6 check contexts, `linear: true`, `force: false`.
