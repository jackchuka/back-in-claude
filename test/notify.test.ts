import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.ts";
import type { Notification } from "../src/types.ts";

const NOTIFICATION: Notification = {
  kind: "limit_reset",
  title: "Claude limit reset",
  message: "5-hour window is open again.",
  priority: "default",
  tags: "white_check_mark",
};

type CapturedCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
};

function createMockFetch(status = 200): [typeof fetch, CapturedCall[]] {
  const calls: CapturedCall[] = [];
  const mockFetch = async (input: string | Request | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object") {
      const h = init.headers;
      for (const [key, value] of Object.entries(h)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
    }
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, headers, body });
    return new Response(null, { status });
  };
  return [mockFetch, calls];
}

describe("notify", () => {
  it("posts the message to the configured topic", async () => {
    const [fetchImpl, calls] = createMockFetch();
    await notify(NOTIFICATION, { topic: "abc123", email: null, fetchImpl });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert(call, "should have a call");
    assert.equal(call.url, "https://ntfy.sh/abc123");
    assert.equal(call.method, "POST");
    assert.equal(call.body, "5-hour window is open again.");
  });

  it("sets title, priority and tags headers", async () => {
    const [fetchImpl, calls] = createMockFetch();
    await notify(NOTIFICATION, { topic: "abc123", email: null, fetchImpl });
    const call = calls[0];
    assert(call, "should have a call");
    assert.equal(call.headers["Title"], "Claude limit reset");
    assert.equal(call.headers["Priority"], "default");
    assert.equal(call.headers["Tags"], "white_check_mark");
  });

  it("includes X-Email when an address is configured", async () => {
    const [fetchImpl, calls] = createMockFetch();
    await notify(NOTIFICATION, { topic: "abc123", email: "me@example.com", fetchImpl });
    const call = calls[0];
    assert(call, "should have a call");
    assert.equal(call.headers["X-Email"], "me@example.com");
  });

  it("omits X-Email when no address is configured", async () => {
    const [fetchImpl, calls] = createMockFetch();
    await notify(NOTIFICATION, { topic: "abc123", email: null, fetchImpl });
    const call = calls[0];
    assert(call, "should have a call");
    assert.ok(!("X-Email" in call.headers));
  });

  it("throws on a non-2xx response so the run fails visibly", async () => {
    const [fetchImpl] = createMockFetch(503);
    await assert.rejects(
      () => notify(NOTIFICATION, { topic: "abc123", email: null, fetchImpl }),
      /503/,
    );
  });

  it("throws when the topic is missing rather than posting nowhere", async () => {
    const [fetchImpl, calls] = createMockFetch();
    await assert.rejects(
      () => notify(NOTIFICATION, { topic: "", email: null, fetchImpl }),
      /topic/i,
    );
    assert.equal(calls.length, 0);
  });
});
