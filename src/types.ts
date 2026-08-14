export const PROBE_RESULTS = ["ok", "rate_limited", "auth_failed", "error"] as const;
export type ProbeResult = (typeof PROBE_RESULTS)[number];

export const LIMIT_STATES = ["unknown", "free", "blocked"] as const;
export type LimitState = (typeof LIMIT_STATES)[number];

export type NotificationKind = "limit_reset" | "auth_failed" | "degraded" | "liveness";

export type Notification = {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly message: string;
  readonly priority: "low" | "default" | "high";
  readonly tags: string;
};

export type NotifiedLatches = {
  readonly limit_reset: string | null;
  readonly auth_failed: string | null;
  readonly liveness: string | null;
};

export type State = {
  readonly state: LimitState;
  readonly since: string | null;
  readonly last_probe: string | null;
  readonly last_result: ProbeResult | null;
  readonly consecutive_errors: number;
  readonly notified: NotifiedLatches;
};

export const INITIAL_STATE: State = Object.freeze({
  state: "unknown",
  since: null,
  last_probe: null,
  last_result: null,
  consecutive_errors: 0,
  notified: Object.freeze({ limit_reset: null, auth_failed: null, liveness: null }),
});

/** Raw result of one CLI invocation, before interpretation. NEVER logged. */
export type RawProbe = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
