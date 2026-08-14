import type { ProbeResult, RawProbe } from "./types.ts";

// Ordered most-specific first. Auth is checked before rate limit: an auth
// failure can incidentally mention limits, but never the reverse.
// HTTP status codes must be anchored to an error-ish word. A bare /\b429\b/
// matches the CLI's OWN telemetry -- `"total_cost_usd":0.429` and
// `"ttft_ms":429` both carry word boundaries around the digits -- so a
// successful probe would be misread as rate-limited, and the user would never
// be told the window reopened.
const AUTH_PATTERNS: readonly RegExp[] = [
  /only authorized for use with claude code/i,
  /(?:error|status|code)\W{0,4}401\b/i,
  /unauthorized/i,
  /authentication[_ ]failed/i,
  /invalid.{0,20}(api key|token|credential)/i,
  /oauth.{0,20}(expired|revoked|invalid)/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit reached/i,
  /rate[_ ]?limit/i,
  /(?:error|status|code)\W{0,4}429\b/i,
  /429\s+too many requests/i,
  /limit will reset/i,
  /out of (usage|credits)/i,
];

const matchesAny = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((p) => p.test(text));

/**
 * Classify a completed Claude CLI invocation.
 *
 * Fail-safe: anything not confidently recognised returns 'error'. A false 'ok'
 * would produce a wrong all-clear, the only outcome that actively misleads.
 */
export function classify({ exitCode, stdout, stderr }: RawProbe): ProbeResult {
  const haystack = `${stdout}\n${stderr}`;

  if (matchesAny(AUTH_PATTERNS, haystack)) return "auth_failed";
  if (matchesAny(RATE_LIMIT_PATTERNS, haystack)) return "rate_limited";
  if (exitCode !== 0) return "error";

  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "is_error" in parsed &&
      parsed.is_error === false
    ) {
      return "ok";
    }
  } catch {
    return "error";
  }

  return "error";
}
