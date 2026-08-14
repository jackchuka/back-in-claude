# Security

## The thing to understand before you use this

This repository is a **template you deploy into your own GitHub account**, and a
working deployment stores `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret.

That token is **equivalent to full access to your Claude account**. It cannot be
scoped down — there is no read-only variant, no per-repository restriction, and
no way to limit what it can do. If it leaks, the only remedy is to revoke it by
generating a new one with `claude setup-token`.

Everything below follows from that.

## If you run this in a public repository

That is the intended configuration — it is why GitHub Actions minutes are free,
which is what makes the 10-minute probe cadence affordable. It is safe _only_
because of specific choices, all of which must be preserved:

- **Triggers are `schedule` and `workflow_dispatch` only.**
  **Never add `pull_request_target`, `issue_comment`, or `workflow_run`.** Those
  run untrusted code from forks with access to your secrets, and they are the
  standard exfiltration route. `pull_request` is safe and is used by `ci.yml`,
  which holds no secrets.
- **The token lives in a GitHub Environment restricted to `main`.** A workflow
  running on any other ref cannot read it.
- **Every action is pinned to a full commit SHA**, not a tag. A retagged action
  could otherwise gain access to the token silently. Dependabot keeps the pins
  current; review those PRs rather than merging them blindly.
- **Nothing from `github.event.*` is interpolated into a `run:` block.**
- **Raw Claude CLI output is never logged.** It contains `session_id`, cost, and
  usage figures, and run logs in a public repository are world-readable. Only a
  classified enum, boolean flags, and sanitized diagnostics (exit code and
  stream _lengths_, never content) are printed.
- **The `NTFY_TOPIC` is itself a secret.** The public ntfy.sh server has no
  per-topic authentication, so anyone who learns your topic name can read your
  notifications and send you spam. It is never printed, and never appears in an
  error message or a URL that could reach a log.
- **The commit step resets `PATH` and neutralises git config** before touching
  the write-scoped `GITHUB_TOKEN`, because `$GITHUB_PATH` prepends the npm
  global bin directory and a package install script could otherwise shadow
  `git` itself.

`zizmor` runs in CI and enforces the workflow half of these rules, so a
regression fails the build rather than shipping.

## Residual risks we have not eliminated

Stated plainly, because a security document that only lists mitigations is
misleading:

- **A malicious pull request that edits a workflow leaks the token** on the next
  scheduled run, if you merge it. Branch protection cannot prevent this on its
  own; reviewing any PR touching `.github/workflows/` is the actual mitigation.
- **The token cannot be scoped**, so its blast radius is your entire Claude
  account. Rotation is the only control.
- **`state.json` is committed on every probe.** In a public repository its
  history is a minute-resolution public record of when you were rate-limited.
  Non-sensitive, but it is information about your working patterns.

## If you would rather not do any of that

Instantiate this template as a **private** repository. Everything works
identically. The cost is that Actions minutes then count against your account
quota, and private repos bill each run at a one-minute floor — so budget a
`*/30` schedule rather than `*/10`, and expect correspondingly slower detection.

## Reporting a vulnerability

Open a [security advisory](https://github.com/jackchuka/back-in-claude/security/advisories/new).
Please do not open a public issue for anything that would expose a token or a
workflow escape.
