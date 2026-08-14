import { readFile, writeFile } from "node:fs/promises";
import { INITIAL_STATE, LIMIT_STATES, PROBE_RESULTS } from "./types.ts";
import type { LimitState, ProbeResult, State } from "./types.ts";

const isLimitState = (v: unknown): v is LimitState =>
  typeof v === "string" && (LIMIT_STATES as readonly string[]).includes(v);

// Mirrors isLimitState. Exists so `last_result` is narrowed rather than cast:
// an unchecked `as ProbeResult` on untrusted JSON is genuinely unsound, and
// oxlint's `no-unsafe-type-assertion` is right to reject it.
const isProbeResult = (v: unknown): v is ProbeResult =>
  typeof v === "string" && (PROBE_RESULTS as readonly string[]).includes(v);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const strip = ({ last_probe: _ignored, ...rest }: State): Omit<State, "last_probe"> => rest;

/**
 * Narrow untrusted JSON to State. Anything unrecognised falls back to
 * INITIAL_STATE — safe, because `unknown -> free` never notifies.
 */
function parseState(rawValue: unknown): State {
  if (!isRecord(rawValue)) return INITIAL_STATE;
  const o = rawValue;
  if (!isLimitState(o["state"])) return INITIAL_STATE;

  const notified = isRecord(o["notified"]) ? o["notified"] : {};

  return {
    state: o["state"],
    since: str(o["since"]),
    last_probe: str(o["last_probe"]),
    last_result: isProbeResult(o["last_result"]) ? o["last_result"] : null,
    consecutive_errors: typeof o["consecutive_errors"] === "number" ? o["consecutive_errors"] : 0,
    notified: {
      limit_reset: str(notified["limit_reset"]),
      auth_failed: str(notified["auth_failed"]),
      liveness: str(notified["liveness"]),
    },
  };
}

export async function readState(path: string): Promise<State> {
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return INITIAL_STATE;
  }
}

export async function writeState(path: string, state: State): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * True when anything other than `last_probe` differs.
 *
 * `last_probe` is excluded here because this function only reports whether the
 * *meaning* of the state changed. The workflow still commits on every probe --
 * its `result != 'skipped'` output triggers that, not this function -- so
 * `last_probe` does advance in the committed state.json, which is exactly what
 * lets the free-state throttle read a fresh `last_probe` on the next run.
 * Everything else -- including consecutive_errors and the liveness latch --
 * must survive, or streak counts and heartbeat timing reset every run.
 */
export function hasMeaningfulChange(before: State, after: State): boolean {
  return JSON.stringify(strip(before)) !== JSON.stringify(strip(after));
}
