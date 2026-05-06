import { toast } from "./toast";
const BASE_URL = import.meta.env.VITE_SURVHUB_API_URL ?? "http://localhost:8787";
const TOKEN_KEY = "survhub_token";
export function setAuthToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}
function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export async function api(path, init) {
  const token = getAuthToken();
  const { silent, ...fetchInit } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (fetchInit.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let response;
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
    try {
      const parsed = JSON.parse(text);
      message = parsed.error ?? parsed.message ?? message;
    } catch {
      /* non-JSON body, keep raw text */
    }
    if (!silent) toast.error(`${response.status} ${path}: ${message}`);
    throw new Error(message);
  }
  return response.json();
}
