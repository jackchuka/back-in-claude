import type { Notification, State } from "./types.ts";

export const LIVENESS_INTERVAL_MS = 7 * 24 * 60 * 60_000;

/** Elapsed ms, or null when either timestamp is unusable. */
function elapsedSince(iso: string | null, nowIso: string): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return now - then;
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
