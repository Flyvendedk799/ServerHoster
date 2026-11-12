// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { ComponentType } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

class StubSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  send() {}
  close() {}
}
globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;

const ROUTES: Record<string, unknown> = {
  "/api/ci/pipelines": {
    pipelines: [],
    attachableServices: [
      {
        id: "svc-awaire",
        name: "Awaire",
        github_repo_url: "https://github.com/flyvende/awaire",
        github_branch: "main"
      }
    ],
    exampleYaml: "steps:\n  - name: Test\n    run: npm test\n"
  },
  "/api/ci/runs": { runs: [] }
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://localhost");
  const body = ROUTES[url.pathname] ?? {};
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}) as typeof fetch;

let CiPage: ComponentType;

describe("CI page", () => {
  beforeAll(async () => {
    CiPage = (await import("./pages/Ci")).CiPage;
  });
  afterEach(() => cleanup());

  it("explains that private repos do not spend GitHub Actions minutes", async () => {
    render(
      <MemoryRouter initialEntries={["/ci"]}>
        <Routes>
          <Route path="/ci" element={<CiPage />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/do not use Actions minutes/)).toBeTruthy());
    expect(screen.getByText(/never register a GitHub Actions runner/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New pipeline/ })).toBeTruthy();
    expect(screen.getByText(/No pipelines yet/)).toBeTruthy();
  });
});
