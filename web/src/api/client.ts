export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}
