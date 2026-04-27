// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { inferNameFromRepoUrl } from "./lib/repo";

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {}
  close() {
    if (this.onclose) this.onclose();
  }
}

globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
globalThis.fetch = (async () =>
  ({
    ok: true,
    json: async () => [],
    text: async () => ""
  }) as Response) as typeof fetch;

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
} as Storage;

describe("App smoke", () => {
  afterEach(() => cleanup());

  it("renders primary navigation", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Services").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("infers launch names from GitHub URLs", () => {
    expect(inferNameFromRepoUrl("https://github.com/acme/Fancy-App.git")).toBe("fancy-app");
    expect(inferNameFromRepoUrl("git@github.com:acme/worker-api.git")).toBe("worker-api");
  });
});
