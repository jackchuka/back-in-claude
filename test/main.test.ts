import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import { readState, writeState } from "../src/state.ts";
import { INITIAL_STATE } from "../src/types.ts";
import type { Notification, RawProbe, State } from "../src/types.ts";

const NOW = "2026-08-14T06:00:00.000Z";
const OK: RawProbe = { exitCode: 0, stdout: '{"is_error":false}', stderr: "" };

const tmpPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "cln-main-")), "state.json");

const seed = async (over: Partial<State>): Promise<string> => {
  const p = await tmpPath();
  // liveness pre-stamped at NOW so it is not due, isolating probe behaviour
  await writeState(p, {
    ...INITIAL_STATE,
    notified: { ...INITIAL_STATE.notified, liveness: NOW },
    ...over,
  });
  return p;
};

function deps(statePath: string, over: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    statePath,
    topic: "topic123",
    email: "me@example.com",
    now: () => NOW,
    probeImpl: async (): Promise<RawProbe> => OK,
    notifyImpl: async (): Promise<void> => {},
    ...over,
  };
}

describe("run", () => {
  it("notifies once and reports changed on blocked -> free", async () => {
    const p = await seed({ state: "blocked" });
    const sent: Notification[] = [];
    const out = await run(
      deps(p, {
        notifyImpl: async (n: Notification) => {
          sent.push(n);
        },
      }),
    );

    assert.equal(out.result, "ok");
    assert.equal(out.changed, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, "limit_reset");
    assert.equal((await readState(p)).state, "free");
  });

  it("probes on every run, however recently the last probe ran", async () => {
    const p = await seed({ state: "free", last_probe: NOW });
    let probeCalls = 0;
    const out = await run(
      deps(p, {
        probeImpl: async (): Promise<RawProbe> => {
          probeCalls += 1;
          return OK;
        },
      }),
    );

    assert.equal(probeCalls, 1, "the cron is the only throttle");
    assert.equal(out.result, "ok");
  });

  // `changed` is the sole commit trigger, and a steady-state tick advances only
  // last_probe. If that counted, git log would become a per-tick public record
  // of this account's rate-limit pattern.
  it("reports no change on a steady-state probe, so the tick does not commit", async () => {
    const p = await seed({
      state: "free",
      last_result: "ok",
      last_probe: "2026-08-14T05:00:00.000Z",
    });
    const out = await run(deps(p));

    assert.equal(out.result, "ok");
    assert.equal(out.changed, false, "free -> free must not produce a commit");
    assert.equal((await readState(p)).last_probe, NOW, "but it is still written to disk");
  });

  it("sends the liveness ping alongside a non-transitioning probe", async () => {
    const p = await tmpPath();
    await writeState(p, { ...INITIAL_STATE, state: "free", last_probe: NOW });
    const sent: Notification[] = [];
    await run(
      deps(p, {
        notifyImpl: async (n: Notification) => {
          sent.push(n);
        },
      }),
    );

    assert.equal(sent.length, 1, "free -> free notifies nothing of its own");
    assert.equal(sent[0]?.kind, "liveness");
    assert.equal((await readState(p)).notified.liveness, NOW);
  });

  it("exercises liveness and a reset-notifying probe in the same run", async () => {
    const p = await tmpPath();
    await writeState(p, {
      ...INITIAL_STATE,
      state: "blocked",
      last_probe: "2026-08-14T05:00:00.000Z",
      notified: { ...INITIAL_STATE.notified, liveness: null },
    });
    const sent: Notification[] = [];
    const out = await run(
      deps(p, {
        notifyImpl: async (n: Notification) => {
          sent.push(n);
        },
      }),
    );

    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((n) => n.kind).toSorted(), ["limit_reset", "liveness"]);
    assert.equal(out.result, "ok");
    const after = await readState(p);
    assert.equal(after.state, "free");
    assert.equal(after.notified.liveness, NOW);
  });

  it("goes blocked without notifying on a rate-limited probe", async () => {
    const p = await seed({ state: "free", last_probe: "2026-08-14T04:00:00.000Z" });
    const sent: Notification[] = [];
    const out = await run(
      deps(p, {
        probeImpl: async (): Promise<RawProbe> => ({
          exitCode: 1,
          stdout: "",
          stderr: "usage limit reached",
        }),
        notifyImpl: async (n: Notification) => {
          sent.push(n);
        },
      }),
    );

    assert.equal(out.result, "rate_limited");
    assert.deepEqual(sent, []);
    assert.equal((await readState(p)).state, "blocked");
  });

  it("persists state before notifying, so a failed send cannot double-notify", async () => {
    const p = await seed({ state: "blocked" });
    await assert.rejects(() =>
      run(
        deps(p, {
          notifyImpl: async (): Promise<void> => {
            throw new Error("ntfy down");
          },
        }),
      ),
    );
    assert.equal((await readState(p)).state, "free");
  });
});
