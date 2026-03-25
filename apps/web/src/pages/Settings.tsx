import { useEffect, useState } from "react";
import { api, clearAuthToken, setAuthToken } from "../lib/api";

export function SettingsPage() {
  const [templates, setTemplates] = useState<{ linux: string; macos: string; windows: string } | null>(null);
  const [backup, setBackup] = useState<string>("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [bootstrapUsername, setBootstrapUsername] = useState("");
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [authInfo, setAuthInfo] = useState("");
  const [httpsInfo, setHttpsInfo] = useState<string>("");
  const [installScripts, setInstallScripts] = useState<string>("");
  const [backupImport, setBackupImport] = useState("");
  const [backupImportStatus, setBackupImportStatus] = useState("");
  const [auditLogs, setAuditLogs] = useState("");
  const [railwayPayload, setRailwayPayload] = useState("");
  const [pythonAnywherePayload, setPythonAnywherePayload] = useState("");
  const [migrationStatus, setMigrationStatus] = useState("");

  useEffect(() => {
    void api<{ linux: string; macos: string; windows: string }>("/service-templates").then(setTemplates);
  }, []);

  async function exportBackup(): Promise<void> {
    const data = await api<{ exportedAt: string; data: unknown }>("/backup/export");
    setBackup(JSON.stringify(data, null, 2));
  }

  async function login(): Promise<void> {
    try {
      const response = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username || undefined, password })
      });
      setAuthToken(response.token);
      setAuthInfo("Login successful");
    } catch {
      setAuthInfo("Login failed");
    }
  }

  async function bootstrapAdmin(): Promise<void> {
    try {
      await api("/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ username: bootstrapUsername, password: bootstrapPassword })
      });
      setAuthInfo("Bootstrap successful");
    } catch {
      setAuthInfo("Bootstrap failed");
    }
  }

  async function loadAuditLogs(): Promise<void> {
    const logs = await api<unknown[]>("/ops/audit-logs?limit=100");
    setAuditLogs(JSON.stringify(logs, null, 2));
  }

  async function generateHttpsCerts(): Promise<void> {
    const data = await api<{
      certPath: string;
      keyPath: string;
      trustGuide: Record<string, string[]>;
    }>("/ops/https/generate", { method: "POST", body: JSON.stringify({}) });
    setHttpsInfo(JSON.stringify(data, null, 2));
  }

  async function checkHttpsStatus(): Promise<void> {
    const data = await api<{
      certExists: boolean;
      keyExists: boolean;
      certPath: string;
      keyPath: string;
      trustGuide: Record<string, string[]>;
    }>("/ops/https/status");
    setHttpsInfo(JSON.stringify(data, null, 2));
  }

  async function exportInstallScripts(): Promise<void> {
    const data = await api<{
      linux: { path: string; script: string };
      macos: { path: string; script: string };
      windows: { path: string; script: string };
    }>("/ops/install-scripts");
    setInstallScripts(JSON.stringify(data, null, 2));
  }

  async function importBackup(): Promise<void> {
    try {
      const parsed = JSON.parse(backupImport) as { data: unknown };
      await api("/backup/import", {
        method: "POST",
        body: JSON.stringify(parsed)
      });
      setBackupImportStatus("Import successful");
    } catch {
      setBackupImportStatus("Import failed");
    }
  }

  async function runRailwayImport(dryRun: boolean): Promise<void> {
    try {
      const payload = JSON.parse(railwayPayload) as { projects: unknown[] };
      const result = await api("/migrations/railway/import", {
        method: "POST",
        body: JSON.stringify({ ...payload, dryRun })
      });
      setMigrationStatus(JSON.stringify(result, null, 2));
    } catch {
      setMigrationStatus("Railway import failed");
    }
  }

  async function runPythonAnywhereImport(dryRun: boolean): Promise<void> {
    try {
      const payload = JSON.parse(pythonAnywherePayload) as { apps: unknown[] };
      const result = await api("/migrations/pythonanywhere/import", {
        method: "POST",
        body: JSON.stringify({ ...payload, dryRun })
      });
      setMigrationStatus(JSON.stringify(result, null, 2));
    } catch {
      setMigrationStatus("PythonAnywhere import failed");
    }
  }

  return (
    <section>
      <h2>Settings and Ops</h2>
      <div className="card form">
        <h3>Authentication</h3>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username (optional, for user login)" />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard password or token" />
        <button onClick={() => void login()}>Login</button>
        <input value={bootstrapUsername} onChange={(event) => setBootstrapUsername(event.target.value)} placeholder="Bootstrap username" />
        <input type="password" value={bootstrapPassword} onChange={(event) => setBootstrapPassword(event.target.value)} placeholder="Bootstrap password (min 8)" />
        <button onClick={() => void bootstrapAdmin()}>Bootstrap admin user</button>
        <button
          onClick={() => {
            void api("/auth/logout", { method: "POST" }).catch(() => undefined);
            clearAuthToken();
            setAuthInfo("Logged out");
          }}
        >
          Logout
        </button>
        <p>{authInfo}</p>
      </div>
      <div className="card">
        <h3>System service templates</h3>
        <p>Linux systemd</p>
        <pre>{templates?.linux}</pre>
        <p>macOS launchd</p>
        <pre>{templates?.macos}</pre>
        <p>Windows service</p>
        <pre>{templates?.windows}</pre>
      </div>
      <div className="card">
        <h3>Backup</h3>
        <button onClick={() => void exportBackup()}>Export backup JSON</button>
        <pre>{backup}</pre>
      </div>
      <div className="card form">
        <h3>Backup Import</h3>
        <textarea
          rows={10}
          placeholder='Paste backup JSON payload: {"data":{...}}'
          value={backupImport}
          onChange={(event) => setBackupImport(event.target.value)}
        />
        <button onClick={() => void importBackup()}>Import backup JSON</button>
        <p>{backupImportStatus}</p>
      </div>
      <div className="card">
        <h3>HTTPS certificates</h3>
        <button onClick={() => void checkHttpsStatus()}>Check cert status</button>
        <button onClick={() => void generateHttpsCerts()}>Generate local certs</button>
        <pre>{httpsInfo}</pre>
      </div>
      <div className="card">
        <h3>Install scripts</h3>
        <button onClick={() => void exportInstallScripts()}>Generate OS install scripts</button>
        <pre>{installScripts}</pre>
      </div>
      <div className="card form">
        <h3>Audit Logs</h3>
        <button onClick={() => void loadAuditLogs()}>Load latest audit logs</button>
        <pre>{auditLogs}</pre>
      </div>
      <div className="card form">
        <h3>Railway Migration</h3>
        <textarea
          rows={8}
          placeholder='{"projects":[{"name":"Project","services":[{"name":"api","type":"docker","image":"nginx:latest"}]}]}'
          value={railwayPayload}
          onChange={(event) => setRailwayPayload(event.target.value)}
        />
        <button onClick={() => void runRailwayImport(true)}>Dry run Railway import</button>
        <button onClick={() => void runRailwayImport(false)}>Execute Railway import</button>
      </div>
      <div className="card form">
        <h3>PythonAnywhere Migration</h3>
        <textarea
          rows={8}
          placeholder='{"apps":[{"name":"myapp","entrypoint":"python app.py","workingDir":"C:/apps/myapp","port":8000}]}'
          value={pythonAnywherePayload}
          onChange={(event) => setPythonAnywherePayload(event.target.value)}
        />
        <button onClick={() => void runPythonAnywhereImport(true)}>Dry run PythonAnywhere import</button>
        <button onClick={() => void runPythonAnywhereImport(false)}>Execute PythonAnywhere import</button>
        <pre>{migrationStatus}</pre>
      </div>
    </section>
  );
}
