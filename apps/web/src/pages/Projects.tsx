import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { api } from "../lib/api";
import { ProjectModal } from "../components/ProjectModal";
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
  const [editingProject, setEditingProject] = useState<{
    id: string;
    name: string;
    description: string;
    gitUrl: string;
  } | null>(null);

  async function load(): Promise<void> {
    const [pRows, sRows] = await Promise.all([api<Project[]>("/projects"), api<Service[]>("/services")]);
    setProjects(pRows);
    setServices(sRows);
  }

  useEffect(() => {
    void load();
  }, []);

  async function deleteProject(id: string, name: string): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete project "${name}"?`,
      message:
        "This will remove the project metadata. Services associated with it will remain active but become unassigned.",
      confirmLabel: "Delete Project",
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
    projects.forEach((p) => (stats[p.id] = { total: 0, running: 0, crashed: 0 }));
    services.forEach((s) => {
      if (stats[s.project_id]) {
        stats[s.project_id].total++;
        if (s.status === "running") stats[s.project_id].running++;
        if (s.status === "crashed") stats[s.project_id].crashed++;
      }
    });
    return stats;
  }, [projects, services]);

  return (
    <div className="projects-page">
      <header className="page-header">
        <h2>Organizational Units</h2>
        <button className="primary" onClick={() => setShowModal(true)}>
          + Create Project
        </button>
      </header>

      <div className="grid">
        {projects.length === 0 ? (
          <div className="card text-center" style={{ gridColumn: "1 / -1", padding: "4rem" }}>
            <div className="muted" style={{ marginBottom: "1rem" }}>
              No projects defined yet.
            </div>
            <button className="primary" onClick={() => setShowModal(true)}>
              Create your first project
            </button>
          </div>
        ) : (
          projects.map((project) => {
            const s = projectStats[project.id];
            return (
              <div key={project.id} className="card service-card">
                <div className="env-tag">PROJECT</div>
                <div className="service-header" style={{ marginBottom: "0.5rem" }}>
                  <div className="service-title-group">
                    <h3>{project.name}</h3>
                    <div className="muted tiny">UUID: {project.id.slice(0, 8)}...</div>
                  </div>
                  <div className="row">
                    <button
                      className="ghost xsmall"
                      onClick={() =>
                        setEditingProject({
                          id: project.id,
                          name: project.name,
                          description: project.description || "",
                          gitUrl: project.git_url || ""
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      className="ghost xsmall logout"
                      onClick={() => void deleteProject(project.id, project.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="service-body">
                  <p className="muted small line-clamp-2" style={{ minHeight: "2.5rem" }}>
                    {project.description || "Project environment for logical service grouping."}
                  </p>

                  <div
                    className="row between"
                    style={{
                      background: "var(--bg-sunken)",
                      padding: "0.5rem",
                      borderRadius: "var(--radius-sm)",
                      marginTop: "0.5rem"
                    }}
                  >
                    <div className="stat-unit">
                      <div className="muted tiny uppercase font-bold">Services</div>
                      <div className="font-semibold">{s?.total || 0}</div>
                    </div>
                    <div className="stat-unit" style={{ textAlign: "right" }}>
                      <div className="muted tiny uppercase font-bold">Running</div>
                      <div
                        className="font-semibold"
                        style={{ color: s?.running > 0 ? "var(--success)" : "inherit" }}
                      >
                        {s?.running || 0}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="service-footer">
                  <Link
                    to={`/services?projectId=${project.id}`}
                    className="button ghost xsmall"
                    style={{ width: "100%", textAlign: "center" }}
                  >
                    Open Project Workspace <ArrowUpRight size={12} />
                  </Link>
                </div>
              </div>
            );
          })
        )}
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

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .projects-page .font-bold { font-weight: 700; }
        .projects-page .font-semibold { font-weight: 600; }
        .projects-page .stat-unit { flex: 1; }
        .projects-page .line-clamp-2 { 
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
      `
        }}
      />
    </div>
  );
}
