import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { ProjectModal } from "../components/ProjectModal";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";

type Service = {
  id: string;
  project_id: string;
  status: string;
};

type Project = {
  id: string;
  name: string;
  description?: string;
  git_url?: string;
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState<{ id: string; name: string; description: string; gitUrl: string } | null>(null);

  async function load(): Promise<void> {
    const [pRows, sRows] = await Promise.all([
      api<Project[]>("/projects"),
      api<Service[]>("/services")
    ]);
    setProjects(pRows);
    setServices(sRows);
  }

  useEffect(() => {
    void load();
  }, []);

  async function deleteProject(id: string, name: string): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete project "${name}"?`,
      message: "This will remove the project but won't delete individual services. You can reassign them later.",
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/projects/${id}`, { method: "DELETE" });
      toast.success(`Project "${name}" removed`);
      await load();
    } catch {
      /* toasted */
    }
  }

  const projectStats = useMemo(() => {
    const stats: Record<string, { total: number; running: number; crashed: number }> = {};
    projects.forEach(p => stats[p.id] = { total: 0, running: 0, crashed: 0 });
    services.forEach(s => {
      if (stats[s.project_id]) {
        stats[s.project_id].total++;
        if (s.status === "running") stats[s.project_id].running++;
        if (s.status === "crashed") stats[s.project_id].crashed++;
      }
    });
    return stats;
  }, [projects, services]);

  return (
    <section>
      <div className="row" style={{ marginBottom: "var(--space-6)", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Projects</h2>
        <button className="primary" onClick={() => setShowModal(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Project
        </button>
      </div>

      <div className="grid">
        {projects.map((project) => {
          const s = projectStats[project.id];
          return (
            <div key={project.id} className="card elevated" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 style={{ margin: 0 }}>{project.name}</h3>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                    ID: {project.id.slice(0, 8)}...
                  </div>
                </div>
                <div className="row" style={{ gap: "0.4rem" }}>
                  <button className="ghost" style={{ padding: "0.4rem" }} onClick={() => setEditingProject({
                    id: project.id,
                    name: project.name,
                    description: project.description || "",
                    gitUrl: project.git_url || ""
                  })}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                  <button className="ghost btn-danger" style={{ padding: "0.4rem" }} onClick={() => void deleteProject(project.id, project.name)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>

              <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", margin: 0, minHeight: "2.8rem" }}>
                {project.description || "No description provided."}
              </p>

              <div className="metric-group" style={{ gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", marginBottom: 0 }}>
                <div className="metric-card" style={{ background: "var(--bg-sunken)", padding: "var(--space-3)", borderRadius: "var(--radius-sm)" }}>
                  <div className="metric-label" style={{ fontSize: "0.65rem" }}>Services</div>
                  <div className="metric-value" style={{ fontSize: "1.2rem" }}>{s?.total || 0}</div>
                </div>
                <div className="metric-card" style={{ background: "var(--bg-sunken)", padding: "var(--space-3)", borderRadius: "var(--radius-sm)" }}>
                  <div className="metric-label" style={{ fontSize: "0.65rem" }}>Running</div>
                  <div className="metric-value" style={{ fontSize: "1.2rem", color: s?.running > 0 ? "var(--success)" : "inherit" }}>
                    {s?.running || 0}
                  </div>
                </div>
              </div>

              {project.git_url && (
                <div className="row" style={{ fontSize: "0.78rem", color: "var(--text-muted)", gap: "0.4rem" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                  <span className="text-truncate" title={project.git_url}>{project.git_url.split('/').pop()}</span>
                </div>
              )}

              <div className="row" style={{ marginTop: "auto", borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-3)" }}>
                <Link to={`/services?projectId=${project.id}`} className="button" style={{ width: "100%", textDecoration: "none" }}>
                  View Project Services →
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {(showModal || editingProject) && (
        <ProjectModal
          project={editingProject}
          onClose={() => {
            setShowModal(false);
            setEditingProject(null);
          }}
          onSaved={() => void load()}
        />
      )}
    </section>
  );
}

