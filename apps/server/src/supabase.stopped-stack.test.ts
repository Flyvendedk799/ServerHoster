/**
 * A Supabase stack whose containers exist but are stopped (host reboot, OOM
 * kill) must come back on Start: ServerHoster starts the stopped containers
 * itself (database first), because the CLI either refuses ("already running")
 * or starts only the database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startStoppedStackContainers } from "./services/resources/profiles/supabase.js";
import type { AppContext } from "./types.js";

function fakeCtx(states: Record<string, string>, failing: string[] = []) {
  const started: string[] = [];
  const docker = {
    listContainers: async () => Object.keys(states).map((name) => ({ Names: [`/${name}`] })),
    getContainer: (name: string) => ({
      inspect: async () => ({ State: { Status: states[name], Running: states[name] === "running" } }),
      start: async () => {
        if (failing.includes(name)) throw new Error("boom");
        started.push(name);
        states[name] = "running";
      }
    })
  };
  return { ctx: { docker } as unknown as AppContext, started };
}

test("starts only stopped containers, database first", async () => {
  const { ctx, started } = fakeCtx({
    supabase_auth_app: "exited",
    supabase_kong_app: "running",
    supabase_db_app: "exited",
    supabase_rest_app: "created"
  });
  const result = await startStoppedStackContainers(ctx, "/nonexistent-workdir");
  assert.equal(started[0], "supabase_db_app");
  assert.deepEqual([...started].sort(), ["supabase_auth_app", "supabase_db_app", "supabase_rest_app"]);
  assert.deepEqual(result, started);
});

test("a container that fails to start does not stop the others", async () => {
  const { ctx, started } = fakeCtx(
    { supabase_db_app: "exited", supabase_auth_app: "exited" },
    ["supabase_db_app"]
  );
  await startStoppedStackContainers(ctx, "/nonexistent-workdir");
  assert.deepEqual(started, ["supabase_auth_app"]);
});

test("all running: nothing started", async () => {
  const { ctx, started } = fakeCtx({ supabase_db_app: "running", supabase_kong_app: "running" });
  assert.deepEqual(await startStoppedStackContainers(ctx, "/nonexistent-workdir"), []);
  assert.deepEqual(started, []);
});
