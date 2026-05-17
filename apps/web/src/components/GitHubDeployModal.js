import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
function GitHubDeployModal({ projects, onClose, onDeployed }) {
  const [step, setStep] = useState(1);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    repoUrl: "",
    branch: "main",
    port: "",
    autoPull: true
  });
  async function loadRepos() {
    setLoading(true);
    try {
      const data = await api("/github/repos");
      setRepos(data);
    } catch {
    } finally {
      setLoading(false);
    }
  }
  function selectRepo(repo) {
    setForm((f) => ({
      ...f,
      repoUrl: repo.clone_url,
      branch: repo.default_branch || "main",
      name: repo.full_name.split("/")[1] || f.name
    }));
    setStep(2);
  }
  async function handleDeploy() {
    if (!form.name || !form.repoUrl) return;
    setDeploying(true);
    try {
      await api("/services/deploy-from-github", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          port: form.port ? Number(form.port) : void 0
        })
      });
      toast.success("Deployment pipeline initiated");
      onDeployed();
      onClose();
    } catch {
    } finally {
      setDeploying(false);
    }
  }
  const filtered = repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase()));
  return /* @__PURE__ */ jsxs("div", { className: "modal-overlay", onClick: onClose, children: [
    /* @__PURE__ */ jsxs("div", { className: "modal-content", style: { maxWidth: "640px" }, onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ jsxs("header", { className: "modal-header", children: [
        /* @__PURE__ */ jsxs("div", { className: "row", children: [
          /* @__PURE__ */ jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: /* @__PURE__ */ jsx("path", { d: "M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" }) }),
          /* @__PURE__ */ jsx("h3", { children: "GitHub GitOps" })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "hint", children: "Deploy automatically from any GitHub repository." })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "modal-body", children: step === 1 ? /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsxs("div", { className: "row", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: "Search your repos...",
              value: search,
              onChange: (e) => setSearch(e.target.value),
              style: { flex: 1 }
            }
          ),
          /* @__PURE__ */ jsx("button", { className: "ghost", onClick: loadRepos, disabled: loading, children: "Refresh List" })
        ] }),
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "repo-list",
            style: {
              marginTop: "1rem",
              maxHeight: "300px",
              overflowY: "auto",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)"
            },
            children: [
              repos.length === 0 && !loading && /* @__PURE__ */ jsx("div", { className: "muted small text-center", style: { padding: "2rem" }, children: "Click Refresh to load your repositories." }),
              loading && /* @__PURE__ */ jsx("div", { className: "muted small text-center", style: { padding: "2rem" }, children: "Scanning universe..." }),
              filtered.map((repo) => /* @__PURE__ */ jsx(
                "div",
                {
                  className: "repo-item",
                  onClick: () => selectRepo(repo),
                  style: {
                    padding: "1rem",
                    borderBottom: "1px solid var(--border-subtle)",
                    cursor: "pointer",
                    transition: "var(--transition)"
                  },
                  children: /* @__PURE__ */ jsxs("div", { className: "row between", children: [
                    /* @__PURE__ */ jsx("span", { className: "font-semibold", children: repo.full_name }),
                    /* @__PURE__ */ jsx("span", { className: "tiny muted", children: repo.default_branch })
                  ] })
                },
                repo.full_name
              ))
            ]
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "form-group", style: { marginTop: "1.5rem" }, children: [
          /* @__PURE__ */ jsx("label", { children: "Or use external URL" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: "https://github.com/...",
              value: form.repoUrl,
              onChange: (e) => setForm({ ...form, repoUrl: e.target.value })
            }
          )
        ] })
      ] }) : /* @__PURE__ */ jsxs("div", { className: "form-column", style: { display: "grid", gap: "1.5rem" }, children: [
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsx("label", { children: "Service Name" }),
          /* @__PURE__ */ jsx("input", { value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "form-row", children: [
          /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
            /* @__PURE__ */ jsx("label", { children: "Target Project" }),
            /* @__PURE__ */ jsxs(
              "select",
              {
                value: form.projectId,
                onChange: (e) => setForm({ ...form, projectId: e.target.value }),
                children: [
                  /* @__PURE__ */ jsx("option", { value: "", children: "Auto: create or reuse app project" }),
                  projects.map((p) => /* @__PURE__ */ jsx("option", { value: p.id, children: p.name }, p.id))
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
            /* @__PURE__ */ jsx("label", { children: "Branch" }),
            /* @__PURE__ */ jsx("input", { value: form.branch, onChange: (e) => setForm({ ...form, branch: e.target.value }) })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsx("label", { children: "Internal Port" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "number",
              value: form.port,
              onChange: (e) => setForm({ ...form, port: e.target.value }),
              placeholder: "3000"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "toggle-group", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: form.autoPull,
              onChange: (e) => setForm({ ...form, autoPull: e.target.checked })
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "toggle-info", children: [
            /* @__PURE__ */ jsx("span", { className: "toggle-title", children: "Automated Pulling (Webhooks)" }),
            /* @__PURE__ */ jsxs("span", { className: "toggle-desc", children: [
              "Automatically rebuild on every push to ",
              form.branch
            ] })
          ] })
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs("footer", { className: "modal-footer", children: [
        /* @__PURE__ */ jsx("button", { className: "ghost", onClick: onClose, children: "Cancel" }),
        step === 2 && /* @__PURE__ */ jsx("button", { className: "ghost", onClick: () => setStep(1), children: "Back" }),
        step === 1 && /* @__PURE__ */ jsx("button", { className: "primary", onClick: () => setStep(2), disabled: !form.repoUrl, children: "Next Step" }),
        step === 2 && /* @__PURE__ */ jsx("button", { className: "primary", onClick: handleDeploy, disabled: deploying, children: deploying ? "Queuing..." : "Start Deployment" })
      ] })
    ] }),
    /* @__PURE__ */ jsx(
      "style",
      {
        dangerouslySetInnerHTML: {
          __html: `
        .repo-item:hover { background: var(--bg-sunken); color: var(--accent-light); }
        .font-semibold { font-weight: 600; }
      `
        }
      }
    )
  ] });
}
export {
  GitHubDeployModal
};
