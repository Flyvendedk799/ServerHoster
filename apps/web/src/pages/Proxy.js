import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  Activity,
  Shield,
  Trash2,
  Plus,
  ExternalLink,
  ArrowRightLeft,
  Server,
  Hash,
  Link2
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { Skeleton, CardSkeleton } from "../components/ui/Skeleton";
export function ProxyPage() {
  const [routes, setRoutes] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ serviceId: "", domain: "", targetPort: "" });
  async function load() {
    try {
      const [routeRows, serviceRows] = await Promise.all([
        api("/proxy/routes", { silent: true }),
        api("/services", { silent: true })
      ]);
      setRoutes(routeRows);
      setServices(serviceRows);
      if (!form.serviceId && serviceRows.length > 0) {
        setForm((p) => ({ ...p, serviceId: serviceRows[0].id }));
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function createRoute() {
    if (!form.domain || !form.targetPort) {
      toast.error("Please specify both domain and port");
      return;
    }
    try {
      await api("/proxy/routes", {
        method: "POST",
        body: JSON.stringify({
          serviceId: form.serviceId,
          domain: form.domain,
          targetPort: Number(form.targetPort)
        })
      });
      setForm((p) => ({ ...p, domain: "", targetPort: "" }));
      toast.success("Edge ingress rule published");
      await load();
    } catch {
      /* toasted */
    }
  }
  async function deleteRoute(route) {
    const ok = await confirmDialog({
      title: "Decommission edge route?",
      message: `Stop routing traffic from ${route.domain}? In-flight requests will be terminated.`,
      danger: true,
      confirmLabel: "Decommission"
    });
    if (!ok) return;
    try {
      await api(`/proxy/routes/${route.id}`, { method: "DELETE" });
      toast.success("Rule disabled successfully");
      await load();
    } catch {
      /* toasted */
    }
  }
  if (loading) {
    return _jsxs("div", {
      className: "proxy-page",
      children: [
        _jsx("header", {
          className: "page-header",
          children: _jsx(Skeleton, { style: { height: "3rem", width: "400px" } })
        }),
        _jsx(Skeleton, { style: { height: "240px", marginBottom: "3rem" } }),
        _jsxs("div", { className: "grid", children: [_jsx(CardSkeleton, {}), _jsx(CardSkeleton, {})] })
      ]
    });
  }
  return _jsxs("div", {
    className: "proxy-page",
    children: [
      _jsx("header", {
        className: "page-header",
        children: _jsxs("div", {
          className: "title-group",
          children: [
            _jsx("h2", { children: "Edge Routing & Ingress" }),
            _jsx("p", {
              className: "muted",
              children: "Expose your local services to the internet with high-performance routing."
            })
          ]
        })
      }),
      _jsxs("section", {
        className: "card glass-card",
        style: { marginBottom: "4rem", border: "1px solid var(--border-glow)" },
        children: [
          _jsx("div", {
            className: "section-title",
            children: _jsxs("div", {
              className: "row",
              children: [
                _jsx(Plus, { className: "text-accent", size: 20 }),
                _jsx("h3", { children: "Register Ingress Rule" })
              ]
            })
          }),
          _jsxs("div", {
            className: "form-row",
            style: { marginTop: "1rem" },
            children: [
              _jsxs("div", {
                className: "form-group",
                children: [
                  _jsx("label", {
                    className: "tiny uppercase font-bold muted",
                    children: "Local Handle (Service)"
                  }),
                  _jsx("select", {
                    value: form.serviceId,
                    onChange: (e) => setForm((p) => ({ ...p, serviceId: e.target.value })),
                    children: services.map((service) =>
                      _jsx("option", { value: service.id, children: service.name }, service.id)
                    )
                  })
                ]
              }),
              _jsxs("div", {
                className: "form-group",
                children: [
                  _jsx("label", {
                    className: "tiny uppercase font-bold muted",
                    children: "Public Endpoint (Domain)"
                  }),
                  _jsxs("div", {
                    className: "row pr-overlap",
                    children: [
                      _jsx(Globe, { size: 18, className: "icon-overlay muted" }),
                      _jsx("input", {
                        className: "with-icon",
                        placeholder: "app.mycustomdomain.com",
                        value: form.domain,
                        onChange: (e) => setForm((p) => ({ ...p, domain: e.target.value }))
                      })
                    ]
                  })
                ]
              }),
              _jsxs("div", {
                className: "form-group",
                style: { maxWidth: "160px" },
                children: [
                  _jsx("label", { className: "tiny uppercase font-bold muted", children: "Port Forward" }),
                  _jsxs("div", {
                    className: "row pr-overlap",
                    children: [
                      _jsx(Hash, { size: 18, className: "icon-overlay muted" }),
                      _jsx("input", {
                        className: "with-icon",
                        type: "number",
                        placeholder: "3000",
                        value: form.targetPort,
                        onChange: (e) => setForm((p) => ({ ...p, targetPort: e.target.value }))
                      })
                    ]
                  })
                ]
              })
            ]
          }),
          _jsx("div", {
            className: "row",
            style: { marginTop: "2rem", justifyContent: "flex-end" },
            children: _jsxs("button", {
              className: "primary",
              onClick: () => void createRoute(),
              children: [_jsx(ArrowRightLeft, { size: 18 }), " Provision Rule"]
            })
          })
        ]
      }),
      _jsx("div", {
        className: "section-title",
        children: _jsxs("div", {
          className: "row",
          children: [
            _jsx(Activity, { className: "text-accent", size: 18 }),
            _jsx("h3", { children: "Active Ingress Rules" }),
            _jsx("span", { className: "badge accent", children: routes.length })
          ]
        })
      }),
      _jsx("div", {
        className: "grid",
        children: _jsx(AnimatePresence, {
          children:
            routes.length === 0
              ? _jsxs(
                  motion.div,
                  {
                    className: "card text-center",
                    style: { gridColumn: "1 / -1", padding: "6rem 2rem", opacity: 0.6 },
                    children: [
                      _jsx(Globe, {
                        size: 60,
                        className: "muted",
                        style: { margin: "0 auto 1.5rem", opacity: 0.2 }
                      }),
                      _jsx("p", {
                        className: "muted font-bold",
                        children: "No active ingress rules detected."
                      }),
                      _jsx("p", {
                        className: "tiny muted",
                        style: { maxWidth: "400px", margin: "1rem auto" },
                        children:
                          "Ingress rules map external DNS records to your private services running in the Survhub cluster."
                      })
                    ]
                  },
                  "empty"
                )
              : routes.map((route) =>
                  _jsxs(
                    motion.div,
                    {
                      layout: true,
                      initial: { opacity: 0, scale: 0.95 },
                      animate: { opacity: 1, scale: 1 },
                      exit: { opacity: 0, scale: 0.95 },
                      className: "card service-card",
                      children: [
                        _jsx("div", {
                          className: "env-tag",
                          style: { border: "1.5px solid var(--info)", color: "var(--info)" },
                          children: _jsxs("div", {
                            className: "row micro",
                            children: [
                              _jsx(Shield, { size: 10 }),
                              " ",
                              _jsx("span", { children: "SSL ACTIVE" })
                            ]
                          })
                        }),
                        _jsx("div", {
                          className: "service-header",
                          style: { marginBottom: "1rem" },
                          children: _jsxs("div", {
                            className: "row",
                            children: [
                              _jsx(Link2, { size: 18, className: "text-accent" }),
                              _jsx("h3", { style: { fontSize: "1.25rem" }, children: route.domain })
                            ]
                          })
                        }),
                        _jsxs("div", {
                          className: "service-body",
                          style: { minHeight: "auto" },
                          children: [
                            _jsx("div", {
                              className: "route-mapping-box",
                              children: _jsxs("div", {
                                className: "row small font-mono",
                                children: [
                                  _jsx("span", {
                                    className: "muted uppercase tiny font-bold",
                                    children: "Local"
                                  }),
                                  _jsxs("span", {
                                    className: "text-accent font-bold",
                                    children: ["127.0.0.1:", route.target_port]
                                  })
                                ]
                              })
                            }),
                            _jsxs("div", {
                              className: "row small",
                              style: { marginTop: "1rem" },
                              children: [
                                _jsx(Server, { size: 14, className: "muted" }),
                                _jsx("span", {
                                  className: "tiny font-bold uppercase muted",
                                  children: "Target:"
                                }),
                                _jsx("span", {
                                  className: "small font-bold",
                                  children:
                                    services.find((s) => s.id === route.service_id)?.name ?? "Dead Link"
                                })
                              ]
                            })
                          ]
                        }),
                        _jsxs("div", {
                          className: "service-footer",
                          style: { marginTop: "1.5rem", borderTop: "1px solid var(--border-subtle)" },
                          children: [
                            _jsxs("button", {
                              className: "ghost text-danger xsmall",
                              onClick: () => void deleteRoute(route),
                              children: [_jsx(Trash2, { size: 14 }), " Remove Rule"]
                            }),
                            _jsxs("a", {
                              href: `http://${route.domain}`,
                              target: "_blank",
                              rel: "noreferrer",
                              className: "button ghost xsmall",
                              style: { marginLeft: "auto" },
                              children: [_jsx(ExternalLink, { size: 14 }), " Open"]
                            })
                          ]
                        })
                      ]
                    },
                    route.id
                  )
                )
        })
      }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
          __html: `
        .proxy-page .font-bold { font-weight: 700; }
        .proxy-page .font-mono { font-family: var(--font-mono); }
        .proxy-page .route-mapping-box { background: var(--bg-sunken); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-default); box-shadow: inset 0 2px 8px rgba(0,0,0,0.3); }
        .proxy-page .micro { gap: 0.25rem; }
        .with-icon { padding-left: 2.5rem !important; }
        .pr-overlap { position: relative; width: 100%; }
        .icon-overlay { position: absolute; left: 0.75rem; top: 12px; pointer-events: none; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.05em; }
        .tiny { font-size: 0.7rem; }
        .text-danger { color: var(--danger) !important; }
      `
        }
      })
    ]
  });
}
