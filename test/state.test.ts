import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, hasMeaningfulChange } from "../src/state.ts";
import { INITIAL_STATE } from "../src/types.ts";

const tmpPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "cln-")), "state.json");

describe("readState", () => {
  it("returns INITIAL_STATE when the file is missing", async () => {
    assert.deepEqual(await readState(await tmpPath()), INITIAL_STATE);
  });

  it("returns INITIAL_STATE when the file is corrupt", async () => {
    const p = await tmpPath();
    await writeFile(p, "not json at all");
    assert.deepEqual(await readState(p), INITIAL_STATE);
  });

  it("returns INITIAL_STATE when the JSON has an invalid state value", async () => {
    const p = await tmpPath();
    await writeFile(p, JSON.stringify({ state: "nonsense" }));
    assert.deepEqual(await readState(p), INITIAL_STATE);
  });

  it("narrows garbage last_result to null", async () => {
    const p = await tmpPath();
    await writeFile(p, JSON.stringify({ state: "free", last_result: "banana" }));
    const state = await readState(p);
    assert.equal(state.last_result, null);
  });
});

describe("writeState", () => {
  it("round-trips through readState", async () => {
    const p = await tmpPath();
    const state = {
      ...INITIAL_STATE,
      state: "blocked" as const,
      since: "2026-08-14T01:00:00.000Z",
    };
    await writeState(p, state);
    assert.deepEqual(await readState(p), state);
  });

  it("ends with a newline for clean diffs", async () => {
    const p = await tmpPath();
    await writeState(p, INITIAL_STATE);
    assert.ok((await readFile(p, "utf8")).endsWith("\n"));
  });
});

describe("hasMeaningfulChange", () => {
  it("ignores a last_probe-only difference", () => {
    const before = { ...INITIAL_STATE, last_probe: "2026-08-14T06:00:00.000Z" };
    const after = { ...INITIAL_STATE, last_probe: "2026-08-14T06:30:00.000Z" };
    assert.equal(hasMeaningfulChange(before, after), false);
  });

  it("detects a state change", () => {
    assert.equal(hasMeaningfulChange(INITIAL_STATE, { ...INITIAL_STATE, state: "blocked" }), true);
  });

  it("detects an error-streak change", () => {
    assert.equal(
      hasMeaningfulChange(INITIAL_STATE, { ...INITIAL_STATE, consecutive_errors: 1 }),
      true,
    );
  });

  it("detects a liveness latch change", () => {
    const after = {
      ...INITIAL_STATE,
      notified: { ...INITIAL_STATE.notified, liveness: "2026-08-14T06:00:00.000Z" },
    };
    assert.equal(hasMeaningfulChange(INITIAL_STATE, after), true);
  });

  it("reports no change for identical states", () => {
    assert.equal(hasMeaningfulChange(INITIAL_STATE, { ...INITIAL_STATE }), false);
  });
});
