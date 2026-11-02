// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { ComponentType } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const store = new Map<string, string>([["survhub_token", "test"]]);
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
} as Storage;

const now = new Date().toISOString();
const existing = {
  id: "t1",
  name: "claude-automation",
  tokenPrefix: "shk_AbCdEfGh",
  scopes: ["admin"],
  createdAt: now,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  status: "active"
};
const minted = {
  ...existing,
  id: "t2",
  name: "ci",
  tokenPrefix: "shk_ZyXwVuTs",
  token: "shk_ZyXwVuTsRqPoNmLkJiHgFeDcBa0123456789abcdefg"
};

const calls: Array<{ method: string; path: string; body?: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, path: url.pathname, body: init?.body as string | undefined });
  const body = method === "POST" ? minted : { tokens: [existing] };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}) as typeof fetch;

let ApiTokensPanel: ComponentType;

describe("Settings → API tokens", () => {
  beforeAll(async () => {
    ApiTokensPanel = (await import("./components/ApiTokensPanel")).ApiTokensPanel;
  });
  afterEach(() => cleanup());

  it("lists tokens without secrets and shows a new token once after creation", async () => {
    render(<ApiTokensPanel />);
    await waitFor(() => expect(screen.getByText("claude-automation")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Revoke/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.change(screen.getByLabelText("Expiry"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /Create token/ }));

    await waitFor(() => expect(screen.getByText(minted.token)).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/auth/tokens");
    expect(JSON.parse(post!.body!)).toEqual({ name: "ci", expiresInDays: 90 });
    expect(screen.getByText(/shown only once/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /I have stored it/ }));
    expect(screen.queryByText(minted.token)).toBeNull();
  });
});
