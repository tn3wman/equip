export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!response.ok)
    throw new Error(
      data.error || data.message || `Request failed (${response.status}).`,
    );
  return data;
}

export async function conditionalGet<T>(
  path: string,
  etag?: string,
): Promise<{ data?: T; etag?: string; unchanged: boolean }> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (response.status === 304)
    return { etag: response.headers.get("etag") ?? etag, unchanged: true };
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!response.ok)
    throw new Error(
      data.error || data.message || `Request failed (${response.status}).`,
    );
  return {
    data: data as T,
    etag: response.headers.get("etag") ?? undefined,
    unchanged: false,
  };
}
