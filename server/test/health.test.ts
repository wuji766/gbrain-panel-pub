// server/test/health.test.ts
import { describe, test, expect } from "bun:test";
import { probeHealth } from "../src/health";
import { startFakeGbrain } from "./helpers";

describe("probeHealth", () => {
  test("健康端口返回 true", async () => {
    const fake = await startFakeGbrain({ mode: "healthy", token: "t" });
    try { expect(await probeHealth(fake.port, 2000)).toBe(true); }
    finally { await fake.stop(); }
  });
  test("无人监听的端口返回 false", async () => {
    expect(await probeHealth(59999, 500)).toBe(false);
  });
});
