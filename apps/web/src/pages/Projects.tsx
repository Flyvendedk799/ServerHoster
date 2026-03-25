import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Project = {
  id: string;
  name: string;
  description?: string;
  git_url?: string;
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({ name: "", description: "", gitUrl: "" });
  const [editing, setEditing] = useState<{ id: string; name: string; description: string; gitUrl: string } | null>(null);

  async function load(): Promise<void> {
    const rows = await api<Project[]>("/projects");
    setProjects(rows);
  }

  useEffect(() => {
    void load();
  }, []);

  async function createProject(): Promise<void> {
    await api("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: form.name,
        description: form.description || undefined,
        gitUrl: form.gitUrl || undefined
      })
    });
    setForm({ name: "", description: "", gitUrl: "" });
    await load();
  }

  async function saveProject(): Promise<void> {
    if (!editing) return;
    await api(`/projects/${editing.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: editing.name,
        description: editing.description,
        gitUrl: editing.gitUrl || undefined
      })
    });
    setEditing(null);
    await load();
  }

  async function deleteProject(id: string): Promise<void> {
    await api(`/projects/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <section>
      <h2>Projects</h2>
      <div className="card form">
        <h3>Create project</h3>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
        <input placeholder="Description" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
        <input placeholder="Git URL" value={form.gitUrl} onChange={(e) => setForm((p) => ({ ...p, gitUrl: e.target.value }))} />
        <button onClick={() => void createProject()}>Create</button>
      </div>

      <div className="grid">
        {projects.map((project) => (
          <div key={project.id} className="card">
            <h3>{project.name}</h3>
            <p>{project.description || "No description"}</p>
            <p>{project.git_url || "No git url"}</p>
            <div className="row">
              <button
                onClick={() =>
                  setEditing({
                    id: project.id,
                    name: project.name,
                    description: project.description || "",
                    gitUrl: project.git_url || ""
                  })
                }
              >
                Edit
              </button>
              <button onClick={() => void deleteProject(project.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="card form">
          <h3>Edit project</h3>
          <input value={editing.name} onChange={(e) => setEditing((p) => (p ? { ...p, name: e.target.value } : p))} />
          <input value={editing.description} onChange={(e) => setEditing((p) => (p ? { ...p, description: e.target.value } : p))} />
          <input value={editing.gitUrl} onChange={(e) => setEditing((p) => (p ? { ...p, gitUrl: e.target.value } : p))} />
          <button onClick={() => void saveProject()}>Save</button>
        </div>
      )}
    </section>
  );
}
