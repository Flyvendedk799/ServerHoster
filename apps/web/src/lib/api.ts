import { toast } from "./toast";

const BASE_URL = import.meta.env.VITE_SURVHUB_API_URL ?? "http://localhost:8787";
const TOKEN_KEY = "survhub_token";

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export type ApiOptions = RequestInit & { silent?: boolean };

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const token = getAuthToken();
  const { silent, ...fetchInit } = init ?? {};
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...fetchInit,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(fetchInit.headers ?? {})
      }
    });
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : String(networkError);
    if (!silent) toast.error(`Network error: ${msg}`);
    throw new Error(`Network error: ${msg}`);
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? message;
    } catch {
      /* non-JSON body, keep raw text */
    }
    if (!silent) toast.error(`${response.status} ${path}: ${message}`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
