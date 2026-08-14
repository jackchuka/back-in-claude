import { appendFile } from "node:fs/promises";
import { classify } from "./classify.ts";
import { isLivenessDue, isProbeDue, livenessNotification } from "./cadence.ts";
import { notify as defaultNotify } from "./notify.ts";
import { probe as defaultProbe } from "./probe.ts";
import { hasMeaningfulChange, readState, writeState } from "./state.ts";
import { transition } from "./transition.ts";
import type { Notification, ProbeResult, RawProbe, State } from "./types.ts";

export type RunDeps = {
  readonly statePath: string;
  readonly topic: string;
  readonly email: string | null;
  readonly now?: () => string;
  readonly probeImpl?: () => Promise<RawProbe>;
  readonly notifyImpl?: (
    n: Notification,
    o: { topic: string; email: string | null },
  ) => Promise<void>;
};

export type RunOutcome = {
  readonly result: ProbeResult | null;
  readonly probed: boolean;
  readonly changed: boolean;
  readonly notifications: readonly Notification[];
  /**
   * Sanitized probe diagnostics for the run log — exit code and stream lengths
   * only, never content. Empty string when no probe ran. Safe to print in a
   * world-readable log; raw stdout/stderr never is.
   */
  readonly diag: string;
};

export async function run({
  statePath,
  topic,
  email,
  now = () => new Date().toISOString(),
  probeImpl = defaultProbe,
  notifyImpl = defaultNotify,
}: RunDeps): Promise<RunOutcome> {
  const nowIso = now();
  const before = await readState(statePath);
  const notifications: Notification[] = [];
  let working: State = before;

  // Liveness is independent of probing: it must fire even on a tick where no
  // probe is due, because a dead schedule is precisely what it detects.
  //
  // The STAMP is applied here, before transition() consumes `working` — if it
  // were applied afterwards, transition's spread of the older `notified` would
  // discard it and the heartbeat would re-fire forever. The NOTIFICATION is held
  // back and appended last (see below); stamp order and emit order are separate
  // concerns and only the stamp must happen here.
  let liveness: Notification | null = null;
  if (isLivenessDue(working, nowIso)) {
    liveness = livenessNotification(working);
    working = { ...working, notified: { ...working.notified, liveness: nowIso } };
  }

  let result: ProbeResult | null = null;
  // Sanitized diagnostics. An `error` classification is otherwise undebuggable
  // from CI, because raw CLI output carries session_id/cost/usage and the run
  // logs are world-readable once this repo is public. Exit code and stream
  // LENGTHS carry no secrets, and they separate the cases that matter:
  // 127 = binary missing, 124 = timeout, 1 + empty streams = produced nothing,
  // 0 + non-empty stdout = ran but did not parse as expected.
  let diag = "";
  if (isProbeDue(working, nowIso)) {
    const raw = await probeImpl();
    result = classify(raw);
    diag = ` exit=${raw.exitCode} out=${raw.stdout.length} err=${raw.stderr.length}`;
    const outcome = transition(working, result, nowIso);
    working = outcome.next;
    notifications.push(...outcome.notifications);
  }

  // Persist BEFORE notifying. If ntfy fails after we have already decided the
  // limit reset, re-detecting it next run would double-notify.
  await writeState(statePath, working);
  const changed = hasMeaningfulChange(before, working);

  // Emit the workflow signal BEFORE notifying, too. Writing to the runner's disk
  // is not persistence — only the commit is, and the workflow commits only when
  // it sees `changed`. If a notification throws with this block after the loop,
  // `run` rejects, `changed` is never emitted, the commit is skipped, and the
  // next run re-detects the same reset and notifies again. That is precisely the
  // double-notify the write-first ordering exists to prevent.
  const ghOutput = process.env["GITHUB_OUTPUT"];
  if (ghOutput) await appendFile(ghOutput, `changed=${changed}\nresult=${result ?? "skipped"}\n`);

  // Transition notifications first, liveness last. The loop aborts on the first
  // failure, so a flaky low-priority heartbeat must not be able to suppress the
  // high-value reset ping in the same run.
  if (liveness) notifications.push(liveness);
  for (const n of notifications) await notifyImpl(n, { topic, email });

  return { result, probed: result !== null, changed, notifications, diag };
}

/**
 * Public repository: run logs are world-readable and GitHub masks only
 * registered secrets. Raw CLI output carries session_id, cost, and usage, so
 * nothing derived from it may be printed. Only our own error messages, on one
 * line, truncated.
 */
function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : "unknown error";
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

if (import.meta.filename === process.argv[1]) {
  try {
    const { result, probed, changed, diag } = await run({
      statePath: process.env["STATE_PATH"] ?? "state.json",
      topic: process.env["NTFY_TOPIC"] ?? "",
      email: process.env["NOTIFY_EMAIL"] ?? null,
    });
    console.log(`probed=${probed} result=${result ?? "skipped"} changed=${changed}${diag}`);
  } catch (err) {
    console.error(`run failed: ${safeMessage(err)}`);
    process.exitCode = 1;
  }
}
