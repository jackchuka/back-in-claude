import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProbeDue,
  isLivenessDue,
  livenessNotification,
  PROBE_INTERVAL_MS,
  LIVENESS_INTERVAL_MS,
} from "../src/cadence.ts";
import { INITIAL_STATE } from "../src/types.ts";
import type { State } from "../src/types.ts";

const at = (ms: number): string => new Date(ms).toISOString();
const stateWith = (over: Partial<State> = {}): State => ({ ...INITIAL_STATE, ...over });

describe("isProbeDue", () => {
  it("is due when no probe has ever run", () => {
    assert.equal(isProbeDue(stateWith(), at(0)), true);
  });

  it("probes every 10 minutes while blocked", () => {
    const s = stateWith({ state: "blocked", last_probe: at(0) });
    assert.equal(isProbeDue(s, at(PROBE_INTERVAL_MS.blocked - 1)), false);
    assert.equal(isProbeDue(s, at(PROBE_INTERVAL_MS.blocked)), true);
  });

  it("backs off to hourly while free", () => {
    const s = stateWith({ state: "free", last_probe: at(0) });
    assert.equal(isProbeDue(s, at(30 * 60_000)), false, "30 min is not due while free");
    assert.equal(isProbeDue(s, at(PROBE_INTERVAL_MS.free)), true);
  });

  it("probes eagerly while unknown to re-establish ground truth", () => {
    const s = stateWith({ state: "unknown", last_probe: at(0) });
    assert.equal(isProbeDue(s, at(PROBE_INTERVAL_MS.unknown)), true);
  });

  it("is due when last_probe is unparseable", () => {
    assert.equal(isProbeDue(stateWith({ last_probe: "garbage" }), at(0)), true);
  });

  it("is due when last_probe is in the future (corrupt clock)", () => {
    const s = stateWith({ state: "free", last_probe: at(10_000_000) });
    assert.equal(isProbeDue(s, at(0)), true);
  });
});

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
});

describe("livenessNotification", () => {
  it("is low priority and reports the current state", () => {
    const n = livenessNotification(stateWith({ state: "free", last_probe: at(0) }));
    assert.equal(n.kind, "liveness");
    assert.equal(n.priority, "low");
    assert.match(n.message, /free/);
  });
});
