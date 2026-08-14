# Claude Limit Notifier — Design

**Date:** 2026-08-14
**Status:** Implemented
**Author:** jackchuka + Claude
**Lives in:** a dedicated **public** repository, usable as a template by others.

## Problem

I frequently exhaust the Claude 5-hour usage window. Claude Code tells me the
limit was reached, but nothing tells me when it clears. I have to poll `/usage`
by hand, or guess and retry.

I want a notification — email and mobile push — the moment the window reopens,
delivered whether or not my Mac is awake, open, or present.

## Goals

- Notify on phone and by email when the 5-hour window reopens.
- **Run entirely in the cloud. No local component of any kind.** This is a hard
  requirement, not a preference. One-time bootstrap (`claude setup-token`) is
  setup, not an operational dependency.
- Detect account-wide: catch limits hit from Claude Code, the phone app, or
  claude.ai alike.
- Use only sanctioned authentication.
- Be safely publishable as a public repository others can adopt.

## Non-goals

- Weekly-cap notifications. The state machine leaves room; not built.
- Auto-resuming work when the limit clears.
- Usage dashboards, burn-rate charts, or cost tracking — `ccusage` does this well.
- Predicting _when_ I will hit the limit.

## Rejected approaches

Recorded so they are not revisited.

**Anything with a local component.** Ruled out by the goals above. This includes
the `StopFailure` hook design (a `rate_limit`-matched hook firing an ntfy message
with a `Delay` header), which is markedly simpler — ~30 lines, no credentials, no
infrastructure, and a more precise reset time — but detects only limits hit
inside Claude Code on the machine running the hook. It was evaluated in depth and
rejected on the local-free requirement.

**Reading rate-limit state from local files.** Verified empirically: a scan of
all 899 session transcripts from the last 60 days found zero rate-limit records.
Claude Code receives the `anthropic-ratelimit-unified-5h-*` headers but does not
persist them (anthropics/claude-code#55333, closed as duplicate, unimplemented).

**Cloud job querying a usage API.** No such API exists. `claude usage --json` was
requested in anthropics/claude-code#44328 and closed as a duplicate of #13585;
still unbuilt. There is nothing to poll.

**Cloud job using a raw Claude Code OAuth token.** Prohibited and non-functional.
Since 2026-01-09 Anthropic returns `This credential is only authorized for use
with Claude Code and cannot be used for other API requests`, and on 2026-02-19
clarified that using Free/Pro/Max OAuth tokens "in any other product, tool, or
service — including the Agent SDK — is not permitted and constitutes a violation
of the Consumer Terms of Service," enforced without prior notice.

**Hosting inside an existing private repository.** Rejected once the project
became something to share. That repository also prohibited commits, which forced
state into the Actions cache; a dedicated repo removes that constraint and lets
state live in a committed `state.json`.

**Cloudflare Workers.** Isolates cannot spawn the Claude CLI. Only the notifier
could live there, which is not the expensive part.

## Approach

Run Claude Code itself, in the cloud, on a schedule, and use _its own ability to
run_ as the signal.

`claude setup-token` issues a long-lived `CLAUDE_CODE_OAUTH_TOKEN`. Anthropic's
own `claude-code-action` documents storing it as a repository secret. Its usage
draws from the subscription's rate limits — the same 5-hour window every other
client shares. That shared metering is what makes it a valid probe, and it is
Claude Code authenticating as Claude Code, so it is not the prohibited pattern.

A scheduled job runs a minimal prompt. Rate-limited means still blocked. Success
means the window is open. The `blocked → free` transition is the notification.

## Architecture

```
GitHub Actions cron (*/10)
        │
        ▼
   ┌──────────┐  state == free && last probe < 60 min ago?
   │  GATE    │────────────────────────────────► exit, no probe
   └────┬─────┘
        │ probe is due
        ▼
   ┌──────────┐   CLAUDE_CODE_OAUTH_TOKEN (environment-scoped)
   │  PROBE   │───────────────────────────────────► Anthropic
   └────┬─────┘
        │ ProbeResult: ok | rate_limited | auth_failed | error
        ▼
   ┌──────────┐
   │  STATE   │  state.json, committed on change
   └────┬─────┘
        │ transition
        ▼
   ┌──────────┐
   │  NOTIFY  │──► ntfy.sh/<topic> ──► phone push
   └──────────┘         + X-Email  ──► email
```

### Adaptive cadence

The cron fires every 10 minutes, but **a probe only runs when it is due**:

| State     | Probe interval      | Why                                                                                                                                        |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `blocked` | 10 min (every tick) | This is the only period where precision matters.                                                                                           |
| `free`    | 60 min              | Only watching for `free → blocked`, which is not notified. Detecting it up to an hour late costs nothing: the reset is still ~5 hours out. |
| `unknown` | 10 min              | Re-establish ground truth quickly.                                                                                                         |

This is only possible because **public repositories get unlimited free Actions
minutes**, so the cheap no-op ticks are free. On a private repo the one-minute
billing floor made every tick cost a minute, which forced a uniform `*/30` and a
30-minute worst-case detection lag. Going public buys 10-minute precision _and_
lowers quota consumption — roughly 49 probes/day versus 48, with three times the
resolution where it counts.

`*/10` rather than `*/5` is deliberate restraint: 144 runs/day is a reasonable
draw on free shared infrastructure, and GitHub deprioritizes very frequent
schedules under load anyway.

### 1. Prober

**Contract:** takes nothing, returns one `ProbeResult`: `ok | rate_limited |
auth_failed | error`.

```
claude -p "ok" --model opus --output-format json \
  --disallowed-tools '*' --no-session-persistence
```

- `--model opus` — deliberate. Probing with a cheaper model can report "free"
  while Opus is still capped, since Max plans meter Opus separately.
- `--disallowed-tools '*'` and `--no-session-persistence` keep it inert.

**Measured cost:** 4,692 cache-creation input tokens + 16 output, $0.047 per
probe. Each run is a fresh session, so there is no cache to hit and no
amortization. At ~49 probes/day that is ~230k tokens/day, roughly 0.4% of a
normal working day's consumption.

**Fail-safe rule:** anything not confidently classified is `error`, never `ok`. A
false all-clear is the only genuinely bad outcome — it teaches me to distrust the
notifier.

### 2. State

**Contract:** `read() -> State`, `write(State)`.

`state.json`, committed to the repo. Durable, diffable, inspectable, and — unlike
the Actions cache — not subject to eviction.

```json
{
  "state": "blocked",
  "since": "2026-08-14T04:10:20Z",
  "last_probe": "2026-08-14T04:25:00Z",
  "last_result": "rate_limited",
  "consecutive_errors": 0,
  "notified": {
    "limit_reset": "2026-08-13T22:00:00Z",
    "auth_failed": null,
    "liveness": "2026-08-10T09:00:00Z"
  }
}
```

States: `unknown` (initial), `free`, `blocked`.

Committed only when something other than `last_probe` changes, so routine ticks
produce no commits.

### 3. State machine

| Current   | Probe          | Next      | Notify                 |
| --------- | -------------- | --------- | ---------------------- |
| `blocked` | `ok`           | `free`    | **"limit reset"**      |
| `blocked` | `rate_limited` | `blocked` | —                      |
| `free`    | `rate_limited` | `blocked` | —                      |
| `free`    | `ok`           | `free`    | —                      |
| `unknown` | `ok`           | `free`    | — (no false all-clear) |
| `unknown` | `rate_limited` | `blocked` | —                      |
| _any_     | `auth_failed`  | unchanged | **"watchdog is down"** |
| _any_     | `error`        | unchanged | — (increment counter)  |

Two rules carry the design:

- **`unknown → free` is silent.** On first run, or after any gap, there is no
  evidence a limit was ever hit. Notifying would fabricate an all-clear.
- **`error` never changes state.** Network blips, runner failures, and Anthropic
  outages must not be mistaken for either condition. After 4 consecutive errors,
  notify once that the watchdog is degraded.

### 4. Liveness ping

Independent of probe results: if more than 7 days have passed since the last
liveness notification, send a low-priority "watchdog alive" message including
the current state and last probe time.

This exists because **every other failure mode in this system is silent.** A
disabled workflow, an expired token that somehow fails to classify, a repo whose
schedule GitHub quietly turned off — all of them present identically to "you
simply haven't been rate-limited lately." Four notifications a month convert an
unnoticeable failure into an obvious one.

### 5. Notifier

**Contract:** `notify(notification, opts)`. One POST reaches both channels:

```
POST https://ntfy.sh/<topic>
  Title, Priority, Tags, X-Email: <address>
```

Topic is a long random string held as a secret. The public ntfy server has no
per-topic auth, so the name is the only barrier; message content is
non-sensitive by design.

## Security

This repository is **public and holds an account-equivalent secret**, so the
posture is deliberate rather than incidental.

**Closing the exfiltration paths:**

- **Triggers are `schedule` and `workflow_dispatch` only.** Never
  `pull_request_target`, `issue_comment`, or `workflow_run` — these run untrusted
  fork code with base-repo secrets and are the standard exfiltration vector.
  `workflow_dispatch` requires write access; `schedule` runs only on the default
  branch. Plain `pull_request` from forks never receives secrets.
- **No untrusted interpolation.** Nothing from `github.event.*` is referenced in
  any `run:` block. Secrets reach the process through `env:` only.
- **The token lives in a GitHub Environment restricted to the `main` branch.**
  Even if a workflow were somehow triggered on another ref, it cannot read the
  secret. Defense in depth behind the trigger restriction.
- **All third-party actions pinned to full commit SHAs.** A retagged `v4` cannot
  silently gain access to the token.
- **`permissions: contents: read`** by default, raised to `contents: write` only
  on the step that commits state.
- **`zizmor` runs in CI**, so a future workflow misconfiguration fails the build
  rather than shipping.
- **Branch protection on `main`.** The workflow file is the sensitive asset; a
  merged malicious PR is the one remaining path to the secret.
- Repository setting: require approval for all outside collaborators.

**Log hygiene — specific to this tool.** Public repos have world-readable run
logs, and GitHub masks only registered secrets. The Claude CLI's JSON output
contains `session_id`, `total_cost_usd`, and token usage, none of which is
masked. Therefore:

- The application prints **only** the classified enum and state, never raw probe
  stdout/stderr.
- Error paths print a sanitized message, never the caught error object —
  `execFile` errors embed the child process's raw output.

**Residual risks, accepted and documented:**

- `CLAUDE_CODE_OAUTH_TOKEN` cannot be scoped down; it is all-or-nothing account
  access. Mitigated only by rotation, which the README must cover.
- Merging a malicious PR that edits the workflow leaks the token on the next
  scheduled run. Branch protection and review discipline are the mitigation.

## Distribution

The repository doubles as a **template**. Others click "Use this template," add
three secrets, and run their own instance. The README documents both paths and
states the token trade-off plainly, so anyone uncomfortable putting an account
token in a public repo can instantiate privately instead — at the cost of their
own Actions minutes.

## Failure modes

| Failure               | Behavior                                 | Detection                        |
| --------------------- | ---------------------------------------- | -------------------------------- |
| Token expired/revoked | `auth_failed` → loud notify, once        | Explicit                         |
| Anthropic outage      | `error`, state held                      | Notify after 4 consecutive       |
| ntfy down             | State still persisted; notification lost | Non-2xx fails the run            |
| Cron drift (5–15 min) | Notification late                        | Accepted                         |
| Repo inactive 60 days | **Schedule auto-disabled**               | Keepalive + weekly liveness ping |
| Two runs overlap      | State write race                         | `concurrency` group, no cancel   |
| Probe misclassified   | False all-clear                          | Fail-safe: unknown ⇒ `error`     |

**On the 60-day rule:** public repositories have scheduled workflows disabled
after 60 days without repository activity, and only _new commits_ reset that
timer — releases, issues, and merged PRs do not, and bot-authored commits are
unreliable. State commits will usually keep it alive, but "usually" is not a
guarantee for a watchdog, which is why the liveness ping exists as the backstop.

## Costs

- ~49 probes/day ≈ 230k tokens/day, ~0.4% of typical consumption. Not zero, and
  it spends the resource it measures.
- GitHub Actions: free and unlimited, public repository, standard runners.

## Testing

- **Prober classification:** unit tests over captured fixtures of each outcome.
- **State machine:** pure function, table-driven tests over every row above.
  This is where correctness lives and it needs no network.
- **Cadence gate:** pure function, tested against the interval table.
- **Notifier:** injected fetch; one manual end-to-end send confirming both push
  and email land.
- **Workflow security:** `zizmor` in CI.

## Open questions

1. **How does `claude -p` signal a rate limit?** Exit code, stderr, or a field in
   `--output-format json`? Everything keys off this. Resolution: capture real
   output at the next genuine limit. Until then the classifier treats
   unrecognized output as `error`, so a wrong guess costs a missed notification,
   never a false all-clear.
2. **Do bot state commits reset the 60-day timer?** Evidence is mixed. If the
   schedule is ever found disabled, add a keepalive that commits under a real
   user identity via a fine-grained PAT scoped to this one repo.
