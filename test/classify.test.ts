import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify.ts";
import type { RawProbe } from "../src/types.ts";

const raw = (over: Partial<RawProbe> = {}): RawProbe => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...over,
});

// Verifies only what it checks: shape, not truthfulness of the values.
const isRawProbe = (v: unknown): v is RawProbe =>
  typeof v === "object" &&
  v !== null &&
  "exitCode" in v &&
  "stdout" in v &&
  "stderr" in v &&
  typeof v.exitCode === "number" &&
  typeof v.stdout === "string" &&
  typeof v.stderr === "string";

describe("classify", () => {
  it("treats exit 0 with a valid non-error JSON result as ok", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "ok" });
    assert.equal(classify(raw({ stdout })), "ok");
  });

  it("detects rate limit phrasing in stderr", () => {
    const stderr = "Claude usage limit reached. Your limit will reset at 3pm.";
    assert.equal(classify(raw({ exitCode: 1, stderr })), "rate_limited");
  });

  it("detects a rate limit reported inside JSON with is_error", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      result: "API Error: 429 rate_limit_error",
    });
    assert.equal(classify(raw({ stdout })), "rate_limited");
  });

  it("detects the credential-restriction message as auth_failed", () => {
    const stderr = "This credential is only authorized for use with Claude Code";
    assert.equal(classify(raw({ exitCode: 1, stderr })), "auth_failed");
  });

  it("detects 401 as auth_failed", () => {
    assert.equal(
      classify(raw({ exitCode: 1, stderr: "API Error: 401 Unauthorized" })),
      "auth_failed",
    );
  });

  it("checks auth before rate limit when both appear", () => {
    const stderr = "invalid api key; rate limit info unavailable";
    assert.equal(classify(raw({ exitCode: 1, stderr })), "auth_failed");
  });

  it("returns error for an unrecognised failure, never ok", () => {
    assert.equal(classify(raw({ exitCode: 1, stderr: "socket hang up" })), "error");
  });

  it("returns error when exit 0 but stdout is unparseable", () => {
    assert.equal(classify(raw({ stdout: "not json" })), "error");
  });

  it("returns error for exit 0 with is_error true and no known signature", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "weird" });
    assert.equal(classify(raw({ stdout })), "error");
  });

  it("returns error when exit is non-zero even with is_error false", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "ok" });
    assert.equal(classify(raw({ exitCode: 3, stdout })), "error");
  });

  it("handles empty streams without throwing", () => {
    assert.equal(classify(raw({ exitCode: 1 })), "error");
  });

  // Regression: a successful probe's own JSON carries cost and timing figures.
  // A bare /\b429\b/ matches "0.429" and '"ttft_ms":429' -- word boundaries
  // exist around digits delimited by '.', ',' and ':' -- so telemetry alone
  // would forge a rate limit and the reset would never be announced.
  it("does not misread its own telemetry numbers as HTTP status codes", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: "ok",
      total_cost_usd: 0.429,
      ttft_ms: 401,
      duration_api_ms: 429,
    });
    assert.equal(classify(raw({ stdout })), "ok");
  });

  it("still detects a rate limit reported as an HTTP status", () => {
    const stderr = "API Error: 429 Too Many Requests";
    assert.equal(classify(raw({ exitCode: 1, stderr })), "rate_limited");
  });

  it("still detects an auth failure reported as a bare HTTP status", () => {
    assert.equal(classify(raw({ exitCode: 1, stderr: "API Error: 401" })), "auth_failed");
  });

  it("classifies real captured CLI output as ok", async () => {
    const { readFile } = await import("node:fs/promises");
    const parsed: unknown = JSON.parse(
      await readFile(new URL("../fixtures/probe-ok.json", import.meta.url), "utf8"),
    );
    assert.ok(isRawProbe(parsed));
    assert.equal(classify(parsed), "ok");
  });
});
