import type { LimitState, Notification, State } from "./types.ts";

/**
 * How often to actually probe, by state. The cron fires every 10 minutes; this
 * decides whether that tick spends quota.
 *
 * `blocked` is the only state where precision matters — it is the window we are
 * waiting to end. While `free` we are only watching for the transition INTO
 * blocked, which is not notified, so learning it up to an hour late costs
 * nothing: the reset is still ~5 hours away.
 */
export const PROBE_INTERVAL_MS: Record<LimitState, number> = {
  blocked: 10 * 60_000,
  unknown: 10 * 60_000,
  free: 60 * 60_000,
};

export const LIVENESS_INTERVAL_MS = 7 * 24 * 60 * 60_000;

/** Elapsed ms, or null when either timestamp is unusable. */
function elapsedSince(iso: string | null, nowIso: string): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return now - then;
}

export function isProbeDue(state: State, nowIso: string): boolean {
  const elapsed = elapsedSince(state.last_probe, nowIso);
  // Unknown or negative elapsed means a missing, corrupt, or future-dated
  // stamp. Probing is the safe response: it costs one probe and re-anchors.
  if (elapsed === null || elapsed < 0) return true;
  return elapsed >= PROBE_INTERVAL_MS[state.state];
}

export function isLivenessDue(state: State, nowIso: string): boolean {
  const elapsed = elapsedSince(state.notified.liveness, nowIso);
  if (elapsed === null || elapsed < 0) return true;
  return elapsed >= LIVENESS_INTERVAL_MS;
}

/**
 * The backstop for every silent failure in this system. A disabled schedule, a
 * dead runner, or a repo GitHub quietly deactivated all present identically to
 * "you simply have not been rate-limited lately." This makes that distinguishable.
 */
export function livenessNotification(state: State): Notification {
  return {
    kind: "liveness",
    title: "Claude watchdog alive",
    message: `State: ${state.state}. Last probe: ${state.last_probe ?? "never"}.`,
    priority: "low",
    tags: "heartbeat",
  };
}
