import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawProbe } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Fixed per the spec. `--model opus` is deliberate: probing with a cheaper model
 * can report "free" while Opus is still capped, because Max plans meter Opus
 * separately. The probe must reflect the model actually being used.
 *
 * Measured cost: 4,692 cache-creation input tokens + 16 output, ~$0.047.
 */
export const PROBE_ARGS: readonly string[] = Object.freeze([
  "-p",
  "ok",
  "--model",
  "opus",
  "--output-format",
  "json",
  "--disallowed-tools",
  "*",
  "--no-session-persistence",
]);

export type ProbeOptions = { readonly timeoutMs?: number };

// A type PREDICATE, not an assertion -- and it only claims what it checks.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Never throws. Every failure mode -- non-zero exit, timeout, missing binary --
 * comes back as a RawProbe for classify() to interpret. This also guarantees
 * raw child output never escapes as an Error message that main might log.
 */
export async function probe({ timeoutMs = 120_000 }: ProbeOptions = {}): Promise<RawProbe> {
  try {
    const { stdout, stderr } = await execFileAsync("claude", [...PROBE_ARGS], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = isRecord(err) ? err : {};
    const code = e["code"];
    const out = e["stdout"];
    const errOut = e["stderr"];
    const message = e["message"];
    return {
      exitCode: typeof code === "number" ? code : 1,
      stdout: typeof out === "string" ? out : "",
      stderr:
        typeof errOut === "string"
          ? errOut
          : typeof message === "string"
            ? message
            : "probe failed",
    };
  }
}
