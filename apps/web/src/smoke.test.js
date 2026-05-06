import { jsx as _jsx } from "react/jsx-runtime";
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { inferNameFromRepoUrl } from "./lib/repo";
class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onmessage = null;
  onclose = null;
  constructor(_url) {}
  close() {
    if (this.onclose) this.onclose();
  }
}
globalThis.WebSocket = MockWebSocket;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => [],
  text: async () => ""
});
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    store.set(k, v);
  },
  removeItem: (k) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
};
describe("App smoke", () => {
  afterEach(() => cleanup());
  it("renders primary navigation", () => {
    render(_jsx(MemoryRouter, { children: _jsx(App, {}) }));
    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Apps").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });
  it("infers launch names from GitHub URLs", () => {
    expect(inferNameFromRepoUrl("https://github.com/acme/Fancy-App.git")).toBe("fancy-app");
    expect(inferNameFromRepoUrl("git@github.com:acme/worker-api.git")).toBe("worker-api");
  });
});
