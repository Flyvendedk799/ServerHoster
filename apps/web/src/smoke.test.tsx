// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

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

describe("App smoke", () => {
  it("renders primary navigation", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
  });
});
