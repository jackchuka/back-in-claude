import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transition, ERROR_STREAK_THRESHOLD } from "../src/transition.ts";
import { INITIAL_STATE } from "../src/types.ts";
import type { State } from "../src/types.ts";

const NOW = "2026-08-14T06:00:00.000Z";
const LATER = "2026-08-14T06:30:00.000Z";
const stateWith = (over: Partial<State> = {}): State => ({ ...INITIAL_STATE, ...over });

describe("transition", () => {
  it("notifies and goes free on blocked + ok", () => {
    const { next, notifications } = transition(stateWith({ state: "blocked" }), "ok", NOW);
    assert.equal(next.state, "free");
    assert.equal(next.since, NOW);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.kind, "limit_reset");
    assert.equal(next.notified.limit_reset, NOW);
  });

  it("goes free SILENTLY on unknown + ok — no fabricated all-clear", () => {
    const { next, notifications } = transition(stateWith(), "ok", NOW);
    assert.equal(next.state, "free");
    assert.deepEqual(notifications, []);
  });

  it("is a no-op on free + ok", () => {
    const prev = stateWith({ state: "free", since: "2026-08-14T01:00:00.000Z" });
    const { next, notifications } = transition(prev, "ok", NOW);
    assert.equal(next.since, "2026-08-14T01:00:00.000Z", "since must not be bumped");
    assert.deepEqual(notifications, []);
  });

  it("goes blocked without notifying on free + rate_limited", () => {
    const { next, notifications } = transition(stateWith({ state: "free" }), "rate_limited", NOW);
    assert.equal(next.state, "blocked");
    assert.equal(next.since, NOW);
    assert.deepEqual(notifications, []);
  });

  it("does not re-notify on blocked + rate_limited", () => {
    const prev = stateWith({ state: "blocked", since: "2026-08-14T01:00:00.000Z" });
    const { next, notifications } = transition(prev, "rate_limited", NOW);
    assert.equal(next.since, "2026-08-14T01:00:00.000Z");
    assert.deepEqual(notifications, []);
  });

  it("goes blocked without notifying on unknown + rate_limited", () => {
    const { next, notifications } = transition(stateWith(), "rate_limited", NOW);
    assert.equal(next.state, "blocked");
    assert.deepEqual(notifications, []);
  });

  it("clears latches on rate_limited as a successful contact", () => {
    const prev = stateWith({
      state: "blocked",
      consecutive_errors: 5,
      notified: { ...INITIAL_STATE.notified, auth_failed: NOW, liveness: NOW },
    });
    const { next, notifications } = transition(prev, "rate_limited", LATER);
    assert.equal(next.consecutive_errors, 0, "clears error streak");
    assert.equal(next.notified.auth_failed, null, "clears auth_failed latch");
    assert.equal(next.notified.liveness, NOW, "preserves liveness latch");
    assert.deepEqual(notifications, []);
  });

  it("notifies loudly and holds state on auth_failed", () => {
    const prev = stateWith({ state: "blocked", since: "2026-08-14T01:00:00.000Z" });
    const { next, notifications } = transition(prev, "auth_failed", NOW);
    assert.equal(next.state, "blocked", "auth failure teaches nothing about the limit");
    assert.equal(next.since, prev.since, "since must be held");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.kind, "auth_failed");
    assert.equal(notifications[0]?.priority, "high");
    assert.equal(next.notified.auth_failed, NOW);
  });

  it("notifies only once for a repeated auth_failed", () => {
    const prev = stateWith({ notified: { ...INITIAL_STATE.notified, auth_failed: NOW } });
    assert.deepEqual(transition(prev, "auth_failed", LATER).notifications, []);
  });

  it("clears the auth_failed latch after a good probe", () => {
    const prev = stateWith({
      state: "free",
      notified: { ...INITIAL_STATE.notified, auth_failed: NOW },
    });
    assert.equal(transition(prev, "ok", LATER).next.notified.auth_failed, null);
  });

  it("preserves the liveness latch across transitions", () => {
    const prev = stateWith({
      state: "blocked",
      notified: { ...INITIAL_STATE.notified, liveness: NOW },
    });
    assert.equal(transition(prev, "ok", LATER).next.notified.liveness, NOW);
  });

  it("holds state and increments the streak on error", () => {
    const prev = stateWith({
      state: "blocked",
      since: "2026-08-14T01:00:00.000Z",
      consecutive_errors: 1,
    });
    const { next, notifications } = transition(prev, "error", NOW);
    assert.equal(next.state, "blocked");
    assert.equal(next.since, prev.since, "since must be held");
    assert.equal(next.consecutive_errors, 2);
    assert.deepEqual(notifications, []);
  });

  it("notifies degraded exactly once at the threshold", () => {
    const prev = stateWith({ consecutive_errors: ERROR_STREAK_THRESHOLD - 1 });
    const { next, notifications } = transition(prev, "error", NOW);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.kind, "degraded");

    const again = transition(next, "error", LATER);
    assert.deepEqual(again.notifications, [], "must not re-notify past the threshold");
  });

  it("resets the error streak on a successful probe", () => {
    const prev = stateWith({ state: "free", consecutive_errors: 9 });
    assert.equal(transition(prev, "ok", NOW).next.consecutive_errors, 0);
  });

  it("records last_probe and last_result for every result", () => {
    const { next } = transition(stateWith(), "error", NOW);
    assert.equal(next.last_probe, NOW);
    assert.equal(next.last_result, "error");
  });

  it("does not mutate the input state", () => {
    const prev = stateWith({ state: "blocked" });
    const snapshot = structuredClone(prev);
    transition(prev, "ok", NOW);
    assert.deepEqual(prev, snapshot);
  });
});
