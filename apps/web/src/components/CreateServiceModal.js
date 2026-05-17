import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
function CreateServiceModal({ projects, onClose, onCreated }) {
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    type: "process",
    command: "",
    workingDir: "",
    image: "",
    port: "",
    enableQuickTunnel: false
  });
  const [loading, setLoading] = useState(false);
  async function handleSubmit() {
    if (!form.name) {
      toast.error("Service name is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          type: form.type,
          command: form.command || void 0,
          workingDir: form.workingDir || void 0,
          image: form.image || void 0,
          port: form.port ? Number(form.port) : void 0,
          quickTunnelEnabled: form.enableQuickTunnel ? 1 : 0
        })
      });
      toast.success(`Service "${form.name}" created`);
      onCreated();
      onClose();
    } catch {
    } finally {
      setLoading(false);
    }
  }
  return /* @__PURE__ */ jsx("div", { className: "modal-overlay", onClick: onClose, children: /* @__PURE__ */ jsxs("div", { className: "modal-content", style: { maxWidth: "540px" }, onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ jsxs("header", { className: "modal-header", children: [
      /* @__PURE__ */ jsx("h3", { children: "Create New Service" }),
      /* @__PURE__ */ jsx("p", { className: "hint", children: "Manually configure or deploy a custom runtime." })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "modal-body", children: [
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Target Project" }),
        /* @__PURE__ */ jsxs("select", { value: form.projectId, onChange: (e) => setForm({ ...form, projectId: e.target.value }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "Auto: create or reuse app project" }),
          projects.map((p) => /* @__PURE__ */ jsx("option", { value: p.id, children: p.name }, p.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-row", children: [
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsxs("label", { children: [
            "Service Name ",
            /* @__PURE__ */ jsx("span", { className: "required", children: "*" })
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: "e.g. my-api",
              value: form.name,
              onChange: (e) => setForm({ ...form, name: e.target.value })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "form-group", style: { maxWidth: "120px" }, children: [
          /* @__PURE__ */ jsxs("label", { children: [
            "Port ",
            /* @__PURE__ */ jsx("span", { className: "optional", children: "(opt)" })
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: "8080",
              value: form.port,
              onChange: (e) => setForm({ ...form, port: e.target.value })
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsx("label", { children: "Deployment Type" }),
        /* @__PURE__ */ jsxs("select", { value: form.type, onChange: (e) => setForm({ ...form, type: e.target.value }), children: [
          /* @__PURE__ */ jsx("option", { value: "process", children: "Binary / Script Process" }),
          /* @__PURE__ */ jsx("option", { value: "docker", children: "Docker Image" }),
          /* @__PURE__ */ jsx("option", { value: "static", children: "Static Web Folder" })
        ] })
      ] }),
      form.type === "docker" ? /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
        /* @__PURE__ */ jsxs("label", { children: [
          "Image Reference ",
          /* @__PURE__ */ jsx("span", { className: "required", children: "*" })
        ] }),
        /* @__PURE__ */ jsx(
          "input",
          {
            placeholder: "e.g. nginx:latest",
            value: form.image,
            onChange: (e) => setForm({ ...form, image: e.target.value })
          }
        )
      ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsxs("label", { children: [
            "Start Command ",
            /* @__PURE__ */ jsx("span", { className: "required", children: "*" })
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js",
              value: form.command,
              onChange: (e) => setForm({ ...form, command: e.target.value })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "form-group", children: [
          /* @__PURE__ */ jsxs("label", { children: [
            "Working Dir ",
            /* @__PURE__ */ jsx("span", { className: "optional", children: "(opt)" })
          ] }),
          /* @__PURE__ */ jsx(
            "input",
            {
              placeholder: "/var/www/app",
              value: form.workingDir,
              onChange: (e) => setForm({ ...form, workingDir: e.target.value })
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "toggle-group", children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "checkbox",
            checked: form.enableQuickTunnel,
            onChange: (e) => setForm({ ...form, enableQuickTunnel: e.target.checked })
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "toggle-info", children: [
          /* @__PURE__ */ jsx("span", { className: "toggle-title", children: "Enable public tunnel" }),
          /* @__PURE__ */ jsx("span", { className: "toggle-desc", children: "Generate an external Cloudflare URL instantly" })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("footer", { className: "modal-footer", children: [
      /* @__PURE__ */ jsx("button", { className: "ghost", onClick: onClose, disabled: loading, children: "Cancel" }),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: handleSubmit, disabled: loading, children: loading ? "Creating..." : "Launch Service" })
    ] })
  ] }) });
}
export {
  CreateServiceModal
};
