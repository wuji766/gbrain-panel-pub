// server/src/health.ts
export async function probeHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
