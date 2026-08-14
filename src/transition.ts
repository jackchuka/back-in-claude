import type { Notification, ProbeResult, State } from "./types.ts";

export const ERROR_STREAK_THRESHOLD = 4;

const LIMIT_RESET: Notification = {
  kind: "limit_reset",
  title: "Claude limit reset",
  message: "5-hour window is open again.",
  priority: "default",
  tags: "white_check_mark",
};

const AUTH_FAILED: Notification = {
  kind: "auth_failed",
  title: "Claude watchdog is down",
  message: "CLAUDE_CODE_OAUTH_TOKEN rejected. Re-run `claude setup-token`.",
  priority: "high",
  tags: "rotating_light",
};

const degraded = (count: number): Notification => ({
  kind: "degraded",
  title: "Claude watchdog degraded",
  message: `${count} consecutive probe errors. Reset detection may be delayed.`,
  priority: "high",
  tags: "warning",
});

export type TransitionOutcome = {
  readonly next: State;
  readonly notifications: readonly Notification[];
};

/**
 * Advance the state machine by one probe.
 *
 * Two invariants carry this design:
 *   - `unknown -> free` is silent. Without evidence a limit was hit, an
 *     all-clear would be fabricated.
 *   - `error` never changes `state`. An outage must not read as a reset.
 */
export function transition(state: State, result: ProbeResult, nowIso: string): TransitionOutcome {
  const base: State = { ...state, last_probe: nowIso, last_result: result };

  switch (result) {
    case "auth_failed": {
      if (state.notified.auth_failed !== null) return { next: base, notifications: [] };
      return {
        next: { ...base, notified: { ...state.notified, auth_failed: nowIso } },
        notifications: [AUTH_FAILED],
      };
    }

    case "error": {
      const consecutive_errors = state.consecutive_errors + 1;
      return {
        next: { ...base, consecutive_errors },
        notifications:
          consecutive_errors === ERROR_STREAK_THRESHOLD ? [degraded(consecutive_errors)] : [],
      };
    }

    case "ok": {
      const cleared: State = {
        ...base,
        consecutive_errors: 0,
        notified: { ...state.notified, auth_failed: null },
      };

      if (state.state === "blocked") {
        return {
          next: {
            ...cleared,
            state: "free",
            since: nowIso,
            notified: { ...cleared.notified, limit_reset: nowIso },
          },
          notifications: [LIMIT_RESET],
        };
      }
      if (state.state === "unknown") {
        return { next: { ...cleared, state: "free", since: nowIso }, notifications: [] };
      }
      return { next: cleared, notifications: [] };
    }

    case "rate_limited": {
      const cleared: State = {
        ...base,
        consecutive_errors: 0,
        notified: { ...state.notified, auth_failed: null },
      };
      if (state.state === "blocked") return { next: cleared, notifications: [] };
      return { next: { ...cleared, state: "blocked", since: nowIso }, notifications: [] };
    }

    default: {
      // Unreachable. This branch exists ONLY to enforce exhaustiveness: adding a
      // fifth ProbeResult makes `result` non-assignable to `never` and fails the
      // build (TS2322). Assigning to never is what does the work — the throw
      // merely gives every path a terminal statement.
      const exhaustive: never = result;
      throw new Error(`unreachable probe result: ${String(exhaustive)}`);
    }
  }
}
