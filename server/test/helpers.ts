// server/test/helpers.ts
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { probeHealth } from "../src/health";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface FakeGbrainHandle { port: number; child: ReturnType<typeof spawn>; stop(): Promise<void> }

export async function startFakeGbrain(opts: {
  mode: "healthy" | "foreign"; token: string; port?: number; healthDelayMs?: number;
}): Promise<FakeGbrainHandle> {
  const port = opts.port ?? await getFreePort();
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "fake-gbrain.ts")], {
    env: {
      ...process.env,
      FAKE_PORT: String(port),
      FAKE_TOKEN: opts.token,
      FAKE_MODE: opts.mode,
      HEALTH_DELAY_MS: String(opts.healthDelayMs ?? 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fake-gbrain 提前退出 code=${child.exitCode}`);
    if (await probeHealth(port, 500)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (child.exitCode !== null) throw new Error("fake-gbrain 未就绪");
  return {
    port, child,
    stop: async () => {
      if (process.platform === "win32") {
        await new Promise<void>(res => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", () => res()));
      } else { child.kill("SIGKILL"); }
      await new Promise(r => setTimeout(r, 200));
    },
  };
}
