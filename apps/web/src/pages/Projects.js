import { jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { api } from "../lib/api";
import { ProjectModal } from "../components/ProjectModal";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
function ProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [services, setServices] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  async function load() {
    await api("/projects/cleanup-empty", { method: "POST", silent: true }).catch(() => void 0);
    const [pRows, sRows] = await Promise.all([api("/projects"), api("/services")]);
    setProjects(pRows);
    setServices(sRows);
  }
  useEffect(() => {
    void load();
  }, []);
  async function deleteProject(id, name) {
    const ok = await confirmDialog({
      title: `Delete project "${name}"?`,
      message: "This will remove the project, its services, managed databases, and stored environment variables.",
      confirmLabel: "Delete Project",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/projects/${id}`, { method: "DELETE" });
      toast.success(`Project "${name}" removed`);
      await load();
    } catch {
    }
  }
  const projectStats = useMemo(() => {
    const stats = {};
    projects.forEach((p) => stats[p.id] = { total: 0, running: 0, crashed: 0 });
    services.forEach((s) => {
      if (stats[s.project_id]) {
        stats[s.project_id].total++;
        if (s.status === "running") stats[s.project_id].running++;
        if (s.status === "crashed") stats[s.project_id].crashed++;
      }
    });
    return stats;
  }, [projects, services]);
  return /* @__PURE__ */ jsxs("div", { className: "projects-page", children: [
    /* @__PURE__ */ jsxs("header", { className: "page-header", children: [
      /* @__PURE__ */ jsx("h2", { children: "Organizational Units" }),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: () => setShowModal(true), children: "+ Create Project" })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "grid", children: projects.length === 0 ? /* @__PURE__ */ jsxs("div", { className: "card text-center", style: { gridColumn: "1 / -1", padding: "4rem" }, children: [
      /* @__PURE__ */ jsx("div", { className: "muted", style: { marginBottom: "1rem" }, children: "No projects defined yet." }),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: () => setShowModal(true), children: "Create your first project" })
    ] }) : projects.map((project) => {
      const s = projectStats[project.id];
      return /* @__PURE__ */ jsxs("div", { className: "card service-card", children: [
        /* @__PURE__ */ jsx("div", { className: "env-tag", children: "PROJECT" }),
        /* @__PURE__ */ jsxs("div", { className: "service-header", style: { marginBottom: "0.5rem" }, children: [
          /* @__PURE__ */ jsxs("div", { className: "service-title-group", children: [
            /* @__PURE__ */ jsx("h3", { children: project.name }),
            /* @__PURE__ */ jsxs("div", { className: "muted tiny", children: [
              "UUID: ",
              project.id.slice(0, 8),
              "..."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "row", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                className: "ghost xsmall",
                onClick: () => setEditingProject({
                  id: project.id,
                  name: project.name,
                  description: project.description || "",
                  gitUrl: project.git_url || ""
                }),
                children: "Edit"
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                className: "ghost xsmall logout",
                onClick: () => void deleteProject(project.id, project.name),
                children: "Delete"
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "service-body", children: [
          /* @__PURE__ */ jsx("p", { className: "muted small line-clamp-2", style: { minHeight: "2.5rem" }, children: project.description || "Project environment for logical service grouping." }),
          /* @__PURE__ */ jsxs(
            "div",
            {
              className: "row between",
              style: {
                background: "var(--bg-sunken)",
                padding: "0.5rem",
                borderRadius: "var(--radius-sm)",
                marginTop: "0.5rem"
              },
              children: [
                /* @__PURE__ */ jsxs("div", { className: "stat-unit", children: [
                  /* @__PURE__ */ jsx("div", { className: "muted tiny uppercase font-bold", children: "Services" }),
                  /* @__PURE__ */ jsx("div", { className: "font-semibold", children: s?.total || 0 })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "stat-unit", style: { textAlign: "right" }, children: [
                  /* @__PURE__ */ jsx("div", { className: "muted tiny uppercase font-bold", children: "Running" }),
                  /* @__PURE__ */ jsx(
                    "div",
                    {
                      className: "font-semibold",
                      style: { color: s?.running > 0 ? "var(--success)" : "inherit" },
                      children: s?.running || 0
                    }
                  )
                ] })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsx("div", { className: "service-footer", children: /* @__PURE__ */ jsxs(
          Link,
          {
            to: `/services?projectId=${project.id}`,
            className: "button ghost xsmall",
            style: { width: "100%", textAlign: "center" },
            children: [
              "Open Project Workspace ",
              /* @__PURE__ */ jsx(ArrowUpRight, { size: 12 })
            ]
          }
        ) })
      ] }, project.id);
    }) }),
    (showModal || editingProject) && /* @__PURE__ */ jsx(
      ProjectModal,
      {
        project: editingProject,
        onClose: () => {
          setShowModal(false);
          setEditingProject(null);
        },
        onSaved: () => void load()
      }
    ),
    /* @__PURE__ */ jsx(
      "style",
      {
        dangerouslySetInnerHTML: {
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
        }
      }
    )
  ] });
}
export {
  ProjectsPage
};
