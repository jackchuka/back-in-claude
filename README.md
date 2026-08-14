# back-in-claude

Get a phone push and an email the moment your Claude 5-hour usage window
reopens. Runs entirely in GitHub Actions — nothing on your machine.

## How it works

A scheduled job runs one minimal Claude Code prompt using a subscription-issued
`CLAUDE_CODE_OAUTH_TOKEN`. Rate-limited means still blocked; success means the
window is open. The `blocked → free` transition sends the notification.

Probing is adaptive: every 10 minutes while `blocked` or `unknown`, hourly while
`free` — while free it is only watching for `free → blocked`, which is not
notified, so detecting that up to an hour late costs nothing.

A probe costs 4,692 cache-creation input tokens plus 16 output tokens, about
$0.047 — measured, not estimated. At this cadence that works out to roughly 0.4%
of a normal working day's usage.

Full rationale, including the alternatives that were rejected and why, is in
[docs/DESIGN.md](docs/DESIGN.md).

## Setup

1. **Use this template** to create your own repository.

2. Generate a long-lived subscription token:

   ```bash
   claude setup-token
   ```

3. Pick an unguessable ntfy topic and subscribe to it in the
   [ntfy app](https://ntfy.sh/app). Save the value somewhere — you cannot read
   it back out of GitHub later:

   ```bash
   openssl rand -hex 12
   ```

4. **Create a `production` environment** (Settings → Environments → New
   environment) and restrict its deployment branches to `main` only. Add the
   three secrets there rather than at repository level, so a workflow running on
   any other ref cannot read them:

   | Secret                    | Value                          |
   | ------------------------- | ------------------------------ |
   | `CLAUDE_CODE_OAUTH_TOKEN` | output of `claude setup-token` |
   | `NTFY_TOPIC`              | the random string from step 3  |
   | `NOTIFY_EMAIL`            | optional, for email delivery   |

5. **Protect `main` — with a bypass for the bot.** The workflow pushes
   `state.json` to `main`, and `GITHUB_TOKEN` cannot push to a branch that
   requires pull requests. Use a **ruleset** (Settings → Rules → Rulesets), not
   classic branch protection:

   - Target branch: `main`
   - Enable **Restrict deletions**, **Block force pushes**, and **Require status
     checks to pass** (select the `check` job from `ci.yml`).
   - Do **not** enable _Require a pull request before merging_ unless you also
     add `github-actions` as a **bypass actor**. Without that bypass every state
     commit fails to push, the run goes red, `last_probe` never advances in the
     committed state, the hourly free-state throttle never engages, and you
     receive duplicate reset notifications.

   The workflow file is the sensitive asset: anyone who can change it can read
   the token. Review any pull request touching `.github/workflows/` accordingly.

6. Trigger a first run to confirm everything is wired:
   `gh workflow run probe.yml`

   It will report `result=ok` and send nothing. That is correct — see the first
   bullet under [Behaviour worth knowing](#behaviour-worth-knowing).

## Security

**This repository is public and holds a secret equivalent to full Claude account
access.** Read [SECURITY.md](SECURITY.md) before deploying your own copy — it
covers the residual risks as well as the mitigations, including the ones that
have not been eliminated.

The short version: this is safe only because of specific choices, all of which
must be preserved:

- **Triggers are `schedule` and `workflow_dispatch` only.** **Never add
  `pull_request_target`, `issue_comment`, or `workflow_run`** — these run
  untrusted fork code with access to your secrets. `pull_request` is safe and is
  used by `ci.yml`, which holds no secrets.
- **The token lives in a `main`-restricted environment**, so a workflow on any
  other ref cannot read it.
- **All actions are SHA-pinned**, and Dependabot keeps those pins current —
  review those PRs rather than merging them blindly.
- **No untrusted interpolation.** Nothing from `github.event.*` is referenced in
  any `run:` block. Secrets reach the process through `env:` only.
- **`zizmor` runs in CI** and enforces the workflow half of these rules, so a
  future misconfiguration fails the build rather than shipping.
- **Raw CLI output is never logged.** It carries `session_id`, cost, and usage
  figures, and public run logs are world-readable. The practical consequence: an
  `error` classification cannot be debugged from the logs beyond its exit code
  and stream lengths — reproduce locally instead.
- **`CLAUDE_CODE_OAUTH_TOKEN` cannot be scoped down.** It is all-or-nothing
  account access. Rotation — re-running `claude setup-token` and updating the
  secret — is the only mitigation if you suspect exposure.

**If you would rather not put an account token in a public repository**,
instantiate this template as a **private** repo instead. Everything works
identically, but Actions minutes then count against your own quota, and private
repos bill each run at a one-minute floor — so drop the schedule in `probe.yml`
to `*/30` and expect correspondingly slower detection.

## Development

```bash
npm install
npm run check      # typecheck + lint + format:check + test
```

Individual scripts:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint --type-aware
npm run format       # oxfmt
npm run format:check # oxfmt --check
npm test             # node --test, TypeScript run natively
```

Toolchain: TypeScript 7 (the Go-native `tsc`), oxlint with type-aware checking
via `oxlint-tsgolint`, and oxfmt. No build step — Node 24+ strips types
natively, so nothing is compiled before it runs. Zero runtime dependencies.

## Behaviour worth knowing

- **The first run is silent by design.** State starts `unknown`, and
  `unknown → free` never notifies — there is no evidence a limit was ever hit,
  so an all-clear would be fabricated.
- **The 60-day rule.** GitHub disables scheduled workflows in public repos after
  60 days without repository activity, and only new commits reset that timer.
  State commits normally prevent this from ever being an issue; the weekly
  liveness ping is the backstop that makes a dead watchdog visible if it happens
  anyway. Fix with one command: `gh workflow enable probe.yml`.
- **The four notification kinds:**
  - **"Claude limit reset"** (normal) — the 5-hour window reopened.
  - **"Claude watchdog alive"** (low, weekly) — heartbeat. If it stops arriving,
    something is wrong; that is its purpose.
  - **"Claude watchdog degraded"** (high) — four consecutive probe errors; reset
    detection may be delayed.
  - **"Claude watchdog is down"** (high) — the token was rejected. Re-run
    `claude setup-token` and update the secret.
- **The CLI cache key freezes the installed version.** `claude-cli-v1` in
  `probe.yml` pins whatever CLI build was cached under that key until the key
  itself is bumped. Detection is loud, not silent: an expired or incompatible
  CLI surfaces as `auth_failed`, which notifies immediately.
- **The workflow commits on every probe** — roughly 40–50 commits/day to `main`.
  That is deliberate: `isProbeDue` reads `last_probe` from the _committed_
  `state.json`, so without those commits the hourly throttle would never engage
  and every tick would probe. The side effect is that `git log` becomes a
  minute-resolution public record of your rate-limit pattern.

## License

[MIT](LICENSE) © jackchuka
