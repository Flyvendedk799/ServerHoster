import { useEffect, useState } from "react";
import { api } from "../lib/api";

type DatabaseRow = {
  id: string;
  name: string;
  engine: string;
  port: number;
  connection_string: string;
};

type Project = { id: string; name: string };

export function DatabasesPage() {
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    engine: "postgres",
    port: "5432"
  });

  async function load(): Promise<void> {
    const [dbs, projs] = await Promise.all([api<DatabaseRow[]>("/databases"), api<Project[]>("/projects")]);
    setRows(dbs);
    setProjects(projs);
    if (!form.projectId && projs.length > 0) {
      setForm((prev) => ({ ...prev, projectId: projs[0].id }));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createDb(): Promise<void> {
    await api("/databases", {
      method: "POST",
      body: JSON.stringify({
        projectId: form.projectId,
        name: form.name,
        engine: form.engine,
        port: Number(form.port)
      })
    });
    setForm((prev) => ({ ...prev, name: "" }));
    await load();
  }

  return (
    <section>
      <h2>Databases</h2>
      <div className="card form">
        <h3>Create database</h3>
        <select value={form.projectId} onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.target.value }))}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Name" />
        <select value={form.engine} onChange={(event) => setForm((prev) => ({ ...prev, engine: event.target.value }))}>
          <option value="postgres">postgres</option>
          <option value="mysql">mysql</option>
          <option value="redis">redis</option>
          <option value="mongo">mongo</option>
        </select>
        <input value={form.port} onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))} placeholder="Port" />
        <button onClick={() => void createDb()}>Create</button>
      </div>

      <div className="grid">
        {rows.map((row) => (
          <div key={row.id} className="card">
            <h3>{row.name}</h3>
            <p>Engine: {row.engine}</p>
            <p>Port: {row.port}</p>
            <p>{row.connection_string}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
