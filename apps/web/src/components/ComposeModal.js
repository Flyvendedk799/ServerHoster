import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
function ComposeModal({ projects, onClose, onImported }) {
  const [projectId, setProjectId] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  async function handleSubmit() {
    if (!content.trim()) {
      toast.error("Compose content is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services/import-compose", {
        method: "POST",
        body: JSON.stringify({ projectId, composeContent: content })
      });
      toast.success("Compose stack imported");
      onImported();
      onClose();
    } catch {
    } finally {
      setLoading(false);
    }
  }
  return /* @__PURE__ */ jsx("div", { className: "modal-overlay", onClick: onClose, children: /* @__PURE__ */ jsxs("div", { className: "modal-content", style: { maxWidth: "700px" }, onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ jsxs("header", { className: "modal-header", children: [
      /* @__PURE__ */ jsx("h3", { children: "Import Docker Compose" }),
      /* @__PURE__ */ jsx("p", { className: "hint", children: "Deploy a multi-service stack using standard YAML." })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "modal-body", children: [
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Target Project" }),
        /* @__PURE__ */ jsxs("select", { value: projectId, onChange: (e) => setProjectId(e.target.value), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "Auto: create or reuse stack project" }),
          projects.map((p) => /* @__PURE__ */ jsx("option", { value: p.id, children: p.name }, p.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Compose YAML Content" }),
        /* @__PURE__ */ jsx(
          "textarea",
          {
            placeholder: "version: '3'...",
            value: content,
            onChange: (e) => setContent(e.target.value),
            rows: 12,
            style: { fontFamily: "var(--font-mono)", fontSize: "0.85rem", background: "var(--bg-sunken)" }
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("footer", { className: "modal-footer", children: [
      /* @__PURE__ */ jsx("button", { className: "ghost", onClick: onClose, disabled: loading, children: "Cancel" }),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: handleSubmit, disabled: loading, children: loading ? "Parsing & Importing..." : "Launch Stack" })
    ] })
  ] }) });
}
export {
  ComposeModal
};
