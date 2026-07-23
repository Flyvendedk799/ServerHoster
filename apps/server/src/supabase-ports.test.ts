import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPortOffsetToToml,
  portsForOffset,
  setTomlPorts,
  SUPABASE_PORT_MAP
} from "./services/resources/supabasePorts.js";

test("portsForOffset: shifts the whole default block by the offset", () => {
  assert.deepEqual(portsForOffset(0), [54321, 54322, 54320, 54329, 54323, 54324, 54327]);
  assert.deepEqual(
    portsForOffset(100),
    [54421, 54422, 54420, 54429, 54423, 54424, 54427]
  );
});

test("applyPortOffsetToToml: a minimal config (only project_id) gains every port section", () => {
  // The real Awaire case: config.toml has no [api]/[db] at all → CLI defaults.
  const toml = 'project_id = "ywggd"\n';
  const out = applyPortOffsetToToml(toml, 100);
  assert.ok(out.includes('project_id = "ywggd"'), "keeps project_id");
  assert.ok(/\[api\]\nport = 54421/.test(out), out);
  assert.ok(out.includes("[db]"), out);
  assert.ok(out.includes("port = 54422"), "db port shifted");
  assert.ok(out.includes("shadow_port = 54420"), "db shadow_port shifted");
  assert.ok(out.includes("[db.pooler]"), out);
  assert.ok(out.includes("port = 54423"), "studio shifted");
  // Every mapped port is present at default+offset.
  for (const p of SUPABASE_PORT_MAP) assert.ok(out.includes(`${p.def + 100}`), `${p.section}.${p.key}`);
});

test("applyPortOffsetToToml: existing port lines are replaced in place, not duplicated", () => {
  const toml = ["project_id = \"x\"", "", "[api]", "enabled = true", "port = 54321", "", "[db]", "port = 54322", "shadow_port = 54320"].join("\n");
  const out = applyPortOffsetToToml(toml, 1100);
  assert.ok(out.includes("port = 55421"), "api port shifted to +1100");
  assert.ok(out.includes("enabled = true"), "sibling keys preserved");
  assert.ok(!out.includes("port = 54321"), "old api port gone");
  assert.ok(!out.includes("port = 54322"), "old db port gone");
  assert.ok(out.includes("shadow_port = 55420"), out);
  // No duplicate [api] section.
  assert.equal(out.match(/^\[api\]$/gm)?.length, 1);
  // No duplicate port key inside [api].
  const apiBlock = out.slice(out.indexOf("[api]"), out.indexOf("[db]"));
  assert.equal(apiBlock.match(/^port =/gm)?.length, 1, apiBlock);
});

test("applyPortOffsetToToml: offset 0 writes the canonical defaults", () => {
  const out = applyPortOffsetToToml('project_id = "x"\n', 0);
  assert.ok(out.includes("port = 54321"));
  assert.ok(out.includes("port = 54322"));
});

test("setTomlPorts: unrelated sections and keys are left untouched", () => {
  const toml = ["project_id = \"x\"", "", "[auth]", "site_url = \"http://localhost:3000\"", "", "[functions.foo]", "verify_jwt = false"].join("\n");
  const out = setTomlPorts(toml, [{ section: "api", key: "port", value: 54421 }]);
  assert.ok(out.includes('site_url = "http://localhost:3000"'), "auth untouched");
  assert.ok(out.includes("[functions.foo]"), "functions untouched");
  assert.ok(out.includes("verify_jwt = false"));
  assert.ok(/\[api\]\nport = 54421/.test(out));
});
