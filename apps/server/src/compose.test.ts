import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ComposeConfig,
  composeCommandPrefix,
  composeStatusFrom,
  findComposeFile,
  findComposeOverlays,
  normalizeComposeProject,
  parseComposePs,
  readComposeProjectName,
  resolveComposeProject,
  writeComposeEnvFile
} from "./services/compose.js";

function withRepo(files: Record<string, string>, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "survhub-compose-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Locating the stack
// ---------------------------------------------------------------------------

test("a root compose file wins over one in a subdirectory", () => {
  withRepo({ "compose.yaml": "services: {}", "deploy/docker-compose.yml": "services: {}" }, (root) => {
    assert.equal(findComposeFile(root), "compose.yaml");
  });
});

test("a compose file in a conventional subdirectory is found", () => {
  withRepo({ "package.json": "{}", "deploy/docker-compose.yml": "services: {}" }, (root) => {
    assert.equal(findComposeFile(root), "deploy/docker-compose.yml");
  });
});

test("a compose file in an unconventional directory is NOT guessed at", () => {
  // Guessing wrong here starts containers rather than merely failing a build,
  // so the search stays shallow — such a repo pins compose_file explicitly.
  withRepo({ "examples/demo/docker-compose.yml": "services: {}" }, (root) => {
    assert.equal(findComposeFile(root), null);
  });
});

test("a repo with no compose file yields null", () => {
  withRepo({ "package.json": "{}" }, (root) => {
    assert.equal(findComposeFile(root), null);
  });
});

test("override and serverhoster overlays beside the compose file are picked up", () => {
  withRepo(
    {
      "deploy/docker-compose.yml": "services: {}",
      "deploy/docker-compose.override.yml": "services: {}",
      "deploy/docker-compose.serverhoster.yml": "services: {}"
    },
    (root) => {
      assert.deepEqual(findComposeOverlays(root, "deploy/docker-compose.yml"), [
        "deploy/docker-compose.override.yml",
        "deploy/docker-compose.serverhoster.yml"
      ]);
    }
  );
});

test("an overlay beside a ROOT compose file has no leading ./", () => {
  withRepo({ "compose.yaml": "services: {}", "compose.override.yaml": "services: {}" }, (root) => {
    assert.deepEqual(findComposeOverlays(root, "compose.yaml"), ["compose.override.yaml"]);
  });
});

test("a repo shipping no overlay yields none", () => {
  withRepo({ "docker-compose.yml": "services: {}" }, (root) => {
    assert.deepEqual(findComposeOverlays(root, "docker-compose.yml"), []);
  });
});

// ---------------------------------------------------------------------------
// Project name — the data-safety invariant. Compose identifies a stack's
// containers, network and NAMED VOLUMES by project name, so resolving it
// differently across two deploys silently orphans the data.
// ---------------------------------------------------------------------------

test("the name declared in a compose file is read", () => {
  withRepo({ "docker-compose.yml": "name: gamehub\nservices: {}\n" }, (root) => {
    assert.equal(readComposeProjectName(path.join(root, "docker-compose.yml")), "gamehub");
  });
});

test("a compose file with no name yields null", () => {
  withRepo({ "docker-compose.yml": "services: {}\n" }, (root) => {
    assert.equal(readComposeProjectName(path.join(root, "docker-compose.yml")), null);
  });
});

test("unparseable yaml yields null rather than throwing", () => {
  withRepo({ "docker-compose.yml": "services: [unclosed\n" }, (root) => {
    assert.equal(readComposeProjectName(path.join(root, "docker-compose.yml")), null);
  });
});

test("project names are lowercased and stripped of illegal characters", () => {
  assert.equal(normalizeComposeProject("My App/Stack"), "my-app-stack");
});

test("a leading non-alphanumeric run is stripped from a project name", () => {
  assert.equal(normalizeComposeProject("__gamehub"), "gamehub");
});

test("normalizing never yields an empty project name", () => {
  assert.equal(normalizeComposeProject("///"), "compose");
});

test("a stored project name beats both the declared name and the service name", () => {
  assert.equal(
    resolveComposeProject({ stored: "gamehub", declared: "other", serviceName: "PlayerZero" }),
    "gamehub"
  );
});

test("the compose file's declared name is used when nothing is stored", () => {
  // This is what lets ServerHoster ADOPT a stack that is already running, with
  // its containers and volumes in place, instead of creating an empty one.
  assert.equal(
    resolveComposeProject({ stored: null, declared: "gamehub", serviceName: "PlayerZero" }),
    "gamehub"
  );
});

test("the slugified service name is the last resort", () => {
  assert.equal(
    resolveComposeProject({ stored: null, declared: null, serviceName: "PlayerZero" }),
    "playerzero"
  );
});

test("resolving a project name never yields an empty string", () => {
  assert.equal(resolveComposeProject({}), "compose");
});

// ---------------------------------------------------------------------------
// The managed env file
// ---------------------------------------------------------------------------

function fakeCtx(serviceDataDir: string) {
  return { config: { serviceDataDir } } as never;
}

test("env vars are written as KEY=VALUE and counted", () => {
  withRepo({}, (root) => {
    const result = writeComposeEnvFile(fakeCtx(root), "svc1", {
      PLATFORM_API_KEY: "sk-test",
      DOMAIN: "playerzero.online"
    });
    assert.equal(result.written, 2);
    const body = fs.readFileSync(result.path, "utf8");
    assert.ok(body.includes("PLATFORM_API_KEY=sk-test"));
    assert.ok(body.includes("DOMAIN=playerzero.online"));
  });
});

test("a value containing a newline is skipped, not written", () => {
  // Compose's env-file parser reads to end of line with no escaping, so an
  // embedded newline would silently become a bogus extra assignment.
  withRepo({}, (root) => {
    const result = writeComposeEnvFile(fakeCtx(root), "svc2", {
      GOOD: "fine",
      PRIVATE_KEY: "-----BEGIN-----\nMIIEow\n-----END-----"
    });
    assert.deepEqual(result.skipped, ["PRIVATE_KEY"]);
    assert.equal(result.written, 1);
    assert.ok(!fs.readFileSync(result.path, "utf8").includes("MIIEow"));
  });
});

test("a key that is not a valid env identifier is skipped", () => {
  withRepo({}, (root) => {
    const result = writeComposeEnvFile(fakeCtx(root), "svc3", { "not-a-key": "x", OK: "y" });
    assert.deepEqual(result.skipped, ["not-a-key"]);
    assert.equal(result.written, 1);
  });
});

test("the env file is written OUTSIDE the git checkout", () => {
  // The deploy system hard-resets the checkout on every pull, so an
  // in-checkout .env would be destroyed on the next deploy.
  withRepo({}, (root) => {
    const result = writeComposeEnvFile(fakeCtx(root), "svc4", { A: "b" });
    assert.equal(result.path, path.join(root, "svc4", "compose.env"));
  });
});

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

const CFG: ComposeConfig = {
  root: "/projects/svc1",
  file: "deploy/docker-compose.yml",
  absFile: "/projects/svc1/deploy/docker-compose.yml",
  dir: "/projects/svc1/deploy",
  project: "gamehub",
  overlays: ["deploy/docker-compose.serverhoster.yml"]
};

test("the project name is pinned explicitly with -p", () => {
  // Without -p, compose derives the project from the working directory — which
  // here is the opaque service id, pointing at an empty project.
  assert.ok(composeCommandPrefix(CFG, "/data/svc1/compose.env").includes('-p "gamehub"'));
});

test("the managed env file is passed so a checkout .env cannot shadow it", () => {
  assert.ok(
    composeCommandPrefix(CFG, "/data/svc1/compose.env").includes('--env-file "/data/svc1/compose.env"')
  );
});

test("the base compose file is listed before its overlays", () => {
  // -f order decides precedence; an overlay listed first would be overridden
  // by the base file instead of overriding it.
  const prefix = composeCommandPrefix(CFG, "/data/svc1/compose.env");
  const base = prefix.indexOf("docker-compose.yml");
  const overlay = prefix.indexOf("docker-compose.serverhoster.yml");
  assert.ok(base > -1);
  assert.ok(overlay > base);
});

// ---------------------------------------------------------------------------
// Reading stack state
// ---------------------------------------------------------------------------

test("newline-delimited JSON from compose ps is parsed", () => {
  const raw = [
    '{"Name":"gamehub-api-1","Service":"api","State":"running","Health":"healthy","ExitCode":0}',
    '{"Name":"gamehub-db-1","Service":"db","State":"running","Health":"healthy","ExitCode":0}'
  ].join("\n");
  const parsed = parseComposePs(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].service, "api");
  assert.equal(parsed[1].state, "running");
});

test("the JSON array shape other compose versions emit is parsed too", () => {
  const parsed = parseComposePs('[{"Name":"a-1","Service":"a","State":"exited","ExitCode":1}]');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].state, "exited");
  assert.equal(parsed[0].exitCode, 1);
});

test("empty compose ps output parses to an empty list", () => {
  assert.deepEqual(parseComposePs("   "), []);
});

test("a malformed line is skipped instead of throwing", () => {
  // Status checks must never fail a service because compose changed a format.
  const raw = ['{"Name":"a-1","Service":"a","State":"running"}', "{truncated"].join("\n");
  assert.equal(parseComposePs(raw).length, 1);
});

const container = (state: string, exitCode = 0) => ({
  name: "x",
  service: "x",
  state,
  health: "",
  exitCode
});

test("a stack with no containers is stopped", () => {
  assert.equal(composeStatusFrom([]), "stopped");
});

test("a stack with containers up is running", () => {
  assert.equal(composeStatusFrom([container("running"), container("running")]), "running");
});

test("a cleanly exited one-shot container does not make the stack crashed", () => {
  // Migration and init containers legitimately finish; calling that a crash
  // would flap the status of every stack that has one.
  assert.equal(composeStatusFrom([container("running"), container("exited", 0)]), "running");
});

test("a container that exited non-zero makes the stack crashed", () => {
  assert.equal(composeStatusFrom([container("running"), container("exited", 1)]), "crashed");
});

test("a dead container makes the stack crashed", () => {
  assert.equal(composeStatusFrom([container("dead")]), "crashed");
});

test("a stack whose containers all exited cleanly is stopped", () => {
  assert.equal(composeStatusFrom([container("exited", 0), container("exited", 0)]), "stopped");
});

test("a restarting container counts as up", () => {
  assert.equal(composeStatusFrom([container("restarting")]), "running");
});
