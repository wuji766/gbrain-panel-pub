// server/test/fixtures/fake-gbrain.ts
// 用 Bun 起一个 HTTP 服务模拟 gbrain serve --http 的最小行为。
// 模式由环境变量控制：FAKE_MODE=healthy|foreign|crash|hang
const mode = process.env.FAKE_MODE ?? "healthy";
const port = Number(process.env.FAKE_PORT ?? 3999);
const token = process.env.FAKE_TOKEN ?? "";
const delay = Number(process.env.HEALTH_DELAY_MS ?? 0);

if (mode === "crash") { console.error("fake crash"); process.exit(1); }

if (mode === "hang") {
  setInterval(() => {}, 60000); // 不监听任何端口，模拟卡死
} else {
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        await new Promise(r => setTimeout(r, delay));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/admin/login") {
        if (mode === "foreign") return new Response("401", { status: 401 });
        const body = await req.json().catch(() => ({}) as { token?: string });
        if (body.token === token) {
          return new Response(null, { status: 204, headers: { "set-cookie": "gbrain_admin=fakesess; Path=/; HttpOnly" } });
        }
        return new Response("401", { status: 401 });
      }
      if (url.pathname === "/admin/api/stats") {
        return Response.json({ pages: 42, facts: 100, sources: 3 });
      }
      if (url.pathname === "/admin/api/health-indicators") {
        return Response.json({ status: "ok", checks: [{ name: "db", ok: true }] });
      }
      if (url.pathname === "/admin/api/api-keys" && req.method === "POST") {
        return Response.json({ key: "fake-api-key-123", name: (await req.json().catch(() => ({}))).name ?? "" });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = await req.json();
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ echo: body.params }) }] } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`fake-gbrain(${mode}) listening :${server.port}`);
}
