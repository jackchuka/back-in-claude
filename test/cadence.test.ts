import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLivenessDue, livenessNotification, LIVENESS_INTERVAL_MS } from "../src/cadence.ts";
import { INITIAL_STATE } from "../src/types.ts";
import type { State } from "../src/types.ts";

const at = (ms: number): string => new Date(ms).toISOString();
const stateWith = (over: Partial<State> = {}): State => ({ ...INITIAL_STATE, ...over });

describe("isLivenessDue", () => {
  it("is due when never sent", () => {
    assert.equal(isLivenessDue(stateWith(), at(0)), true);
  });

  it("is not due before 7 days", () => {
    const s = stateWith({ notified: { ...INITIAL_STATE.notified, liveness: at(0) } });
    assert.equal(isLivenessDue(s, at(LIVENESS_INTERVAL_MS - 1)), false);
  });

  it("is due at exactly 7 days", () => {
    const s = stateWith({ notified: { ...INITIAL_STATE.notified, liveness: at(0) } });
    assert.equal(isLivenessDue(s, at(LIVENESS_INTERVAL_MS)), true);
  });

  it("is due when the stamp is unparseable", () => {
    const s = stateWith({ notified: { ...INITIAL_STATE.notified, liveness: "garbage" } });
    assert.equal(isLivenessDue(s, at(0)), true);
  });

  it("is due when the stamp is in the future (corrupt clock)", () => {
    const s = stateWith({ notified: { ...INITIAL_STATE.notified, liveness: at(10_000_000) } });
    assert.equal(isLivenessDue(s, at(0)), true);
  });
});

describe("livenessNotification", () => {
  it("is low priority and reports the current state", () => {
    const n = livenessNotification(stateWith({ state: "free", last_probe: at(0) }));
    assert.equal(n.kind, "liveness");
    assert.equal(n.priority, "low");
    assert.match(n.message, /free/);
  });
});
