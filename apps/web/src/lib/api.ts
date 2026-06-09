import { toast } from "./toast";

const BASE_URL = import.meta.env.VITE_SURVHUB_API_URL ?? "http://localhost:8787";
export const API_BASE_URL = BASE_URL;
const TOKEN_KEY = "survhub_token";
const AUTH_EXPIRED_EVENT = "survhub:auth-expired";

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function expireAuthToken(): void {
  if (getAuthToken()) {
    clearAuthToken();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
}

function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export type ApiOptions = RequestInit & {
  /** Suppress the error toast (for background polls / handled errors). */
  silent?: boolean;
  /**
   * Don't trigger the global session-expired redirect on a 401. For long-lived
   * background loops (e.g. the Cloudflare re-auth status poll) where a transient
   * 401 must not yank the user out of their flow. Distinct from `silent`, which
   * many foreground calls set while still wanting the 401 redirect.
   */
  noAuthExpiry?: boolean;
};

/** An error from a non-2xx API response, carrying the server's machine-readable
 * `code`/`meta` so callers can render a tailored recovery UX. */
export class ApiError extends Error {
  status: number;
  code?: string;
  meta?: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const token = getAuthToken();
  const { silent, noAuthExpiry, ...fetchInit } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (fetchInit.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...fetchInit,
      headers
    });
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : String(networkError);
    if (!silent) toast.error(`Network error: ${msg}`);
    throw new Error(`Network error: ${msg}`);
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed (${response.status})`;
    let code: string | undefined;
    let meta: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        message?: string;
        code?: string;
        meta?: Record<string, unknown>;
      };
      message = parsed.error ?? parsed.message ?? message;
      code = parsed.code;
      meta = parsed.meta;
    } catch {
      /* non-JSON body, keep raw text */
    }
    // A 401 expires the session by default (incl. silent foreground calls like
    // deploy-from-github). Only loops that opt out with `noAuthExpiry` — the
    // Cloudflare re-auth status poll — are spared the global redirect so a
    // transient 401 can't yank the user mid-flow.
    if (response.status === 401 && !noAuthExpiry) {
      expireAuthToken();
    }
    if (!silent) toast.error(`${response.status} ${path}: ${message}`);
    throw new ApiError(message, response.status, code, meta);
  }
  return response.json() as Promise<T>;
}
