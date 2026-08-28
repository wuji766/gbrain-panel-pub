// server/src/orchestrator.ts
import type { PanelConfig } from "./config";
import { probeHealth } from "./health";
import { adminLoginRequest } from "./gbrain-client";

export type OrchState = "idle" | "probing" | "spawning" | "starting" | "own" | "attached" | "foreign" | "stopped" | "error";

export interface OrchestratorOpts {
  spawnSpec?: { bin: string; baseArgs: string[] };
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnEnvExtra?: Record<string, string>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Orchestrator {
  private proc: Bun.Subprocess | null = null;
  private state: OrchState = "idle";
  private effectivePort: number;
  private logs: string[] = [];
  private listeners = new Set<(s: OrchState) => void>();
  private readonly spawnSpec: { bin: string; baseArgs: string[] };
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly opts: OrchestratorOpts;
  // 与简报参考实现的最小偏差（TDD 以测试为规格）：
  // 简报测试的 makeOrch 未通过 spawnEnvExtra 传 FAKE_PORT，而 fake-gbrain 替身只认
  // 环境变量 FAKE_PORT、不解析 --port 命令行参数；且 fallback 端口在运行期才确定，
  // 测试侧无法预置。故在"注入 spawnSpec 的测试模式"下额外同步 FAKE_PORT=<port>，
  // 保证替身与编排器轮询同一端口。生产路径（未注入 spawnSpec）不设该变量，不受影响。
  private readonly injectedSpawn: boolean;

  constructor(private cfg: PanelConfig, opts: OrchestratorOpts = {}) {
    this.opts = opts;
    this.injectedSpawn = opts.spawnSpec !== undefined;
    this.spawnSpec = opts.spawnSpec ?? { bin: cfg.gbrainBin, baseArgs: [] };
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.effectivePort = cfg.gbrainPort;
  }

  getState(): OrchState { return this.state; }
  getEffectivePort(): number { return this.effectivePort; }
  getRecentLogs(): string[] { return [...this.logs]; }
  onStateChange(cb: (s: OrchState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: OrchState, log?: string) {
    this.state = s;
    if (log) this.log(log);
    for (const cb of this.listeners) cb(s);
  }
  private log(line: string) {
    this.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logs.length > 200) this.logs.shift();
  }

  async start(): Promise<OrchState> {
    // 重入守卫：starting/own 时直接返回，不重探测（own 重探测遇 token 不匹配会误判 foreign）
    // 也不重拉（避免双进程抢端口）。attached/foreign 允许重探测以跟随外部状态变化。
    if (this.state === "starting" || this.state === "own") return this.state;
    this.setState("probing");
    if (await probeHealth(this.cfg.gbrainPort, 2000)) {
      const ok = (await adminLoginRequest(this.cfg.gbrainPort, this.cfg.bootstrapToken)) !== null;
      this.setState(ok ? "attached" : "foreign");
      return this.state;
    }
    return this.spawnAt(this.cfg.gbrainPort);
  }

  async spawnOnFallbackPort(): Promise<OrchState> {
    if (this.state !== "foreign" && this.state !== "error") {
      this.log(`spawnOnFallbackPort 拒绝：当前状态 ${this.state}`);
      return this.state;
    }
    for (let p = this.cfg.gbrainPort + 1; p <= this.cfg.gbrainPort + 5; p++) {
      if (await probeHealth(p, 500)) continue;
      const result = await this.spawnAt(p);
      if (result === "own") return result;
    }
    this.setState("error", "fallback 端口全部失败");
    return this.state;
  }

  private async spawnAt(port: number): Promise<OrchState> {
    // 重入守卫：上一个自己的子进程仍存活（未退出）时先清理再 spawn，防双进程/端口冲突。
    // killServe 只处理 this.proc（自己的进程），attached/foreign 场景 this.proc 为 null 不受影响。
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.log("spawn 前清理仍存活的上一个子进程");
      await this.killServe();
    }
    this.setState("spawning", `spawn serve @${port}`);
    this.effectivePort = port;
    const args = [...this.spawnSpec.baseArgs, "serve", "--http", "--surface", "full",
      "--port", String(port), "--suppress-bootstrap-token"];
    this.proc = Bun.spawn([this.spawnSpec.bin, ...args], {
      env: {
        ...process.env,
        ...(this.injectedSpawn ? { FAKE_PORT: String(port) } : {}), // 测试替身端口桥接，见类头注释
        ...(this.opts.spawnEnvExtra ?? {}),
        GBRAIN_HOME: this.cfg.gbrainHome,
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: this.cfg.bootstrapToken,
      },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
      windowsHide: true,
    });
    this.pipeLogs(this.proc.stdout, "out");
    this.pipeLogs(this.proc.stderr, "err");
    this.proc.exited.then(code => {
      if (this.state === "starting" || this.state === "own") {
        this.setState("error", `serve 意外退出 code=${code}`);
      } else if (this.state !== "stopped") {
        this.setState("stopped", `serve 退出 code=${code}`);
      }
    });
    this.setState("starting");
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeHealth(port, 1000)) { this.setState("own", `serve 就绪 @${port}`); return "own"; }
      if (!this.proc || this.proc.exitCode !== null) break; // 已退出（proc 可能已被并发 killServe 置空）
      await sleep(this.pollIntervalMs);
    }
    if (this.state !== "own") this.setState("error", "健康等待超时");
    return this.state;
  }

  // 参数类型用 Bun.Subprocess["stdout"]（number | ReadableStream | undefined）与 spawn 返回值对齐；
  // 我们固定 stdout/stderr: "pipe"，number（fd 继承）与 undefined 分支只是类型收窄守卫，不会走到。
  private pipeLogs(stream: Bun.Subprocess["stdout"], tag: string) {
    if (!stream || typeof stream === "number") return;
    (async () => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split(/\r?\n/)) {
          if (line.trim()) this.log(`[serve/${tag}] ${line}`);
        }
      }
    })().catch(() => {});
  }

  /** 停止自有 serve。返回被杀子进程的 pid（attached/foreign 无自有进程、或子进程已自行退出时返回 null），
   *  供备份活锁判据比对锁内 PID（自有尸锁放行）使用；其余调用方忽略返回值即可。 */
  async killServe(): Promise<number | null> {
    if (!this.proc) { this.setState("stopped"); return null; } // attached/foreign：绝不杀别人的进程
    // 死 PID 守卫：子进程已自行退出（exitCode 非 null，或被信号杀死时 exitCode 保持 null 而
    // signalCode 非 null）时直接收尾，避免对已退出 PID 发 taskkill（该 PID 可能已被系统复用，误杀无关进程）。
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      this.log(`serve 已自行退出（code=${this.proc.exitCode}），无需 taskkill`);
      this.proc = null;
      this.setState("stopped");
      return null;
    }
    const pid = this.proc.pid;
    this.log(`taskkill /PID ${pid} /T /F`);
    await new Promise<void>(res => {
      Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true }).exited.then(() => res());
    });
    this.proc = null;
    this.setState("stopped", "serve 已停止");
    return pid;
  }
}
