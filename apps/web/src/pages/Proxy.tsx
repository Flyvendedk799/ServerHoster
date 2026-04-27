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

type RouteRow = {
  id: string;
  service_id: string;
  domain: string;
  target_port: number;
};

type Service = { id: string; name: string };

export function ProxyPage() {
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ serviceId: "", domain: "", targetPort: "" });

  async function load(): Promise<void> {
    try {
      const [routeRows, serviceRows] = await Promise.all([
        api<RouteRow[]>("/proxy/routes", { silent: true }), 
        api<Service[]>("/services", { silent: true })
      ]);
      setRoutes(routeRows);
      setServices(serviceRows);
      if (!form.serviceId && serviceRows.length > 0) {
        setForm((p) => ({ ...p, serviceId: serviceRows[0].id }));
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createRoute(): Promise<void> {
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
    } catch { /* toasted */ }
  }

  async function deleteRoute(route: RouteRow): Promise<void> {
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
    } catch { /* toasted */ }
  }

  if (loading) {
    return (
      <div className="proxy-page">
         <header className="page-header"><Skeleton style={{ height: "3rem", width: "400px" }} /></header>
         <Skeleton style={{ height: "240px", marginBottom: "3rem" }} />
         <div className="grid">
            <CardSkeleton /><CardSkeleton />
         </div>
      </div>
    );
  }

  return (
    <div className="proxy-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Edge Routing & Ingress</h2>
          <p className="muted">Expose your local services to the internet with high-performance routing.</p>
        </div>
      </header>

      <section className="card glass-card" style={{ marginBottom: "4rem", border: "1px solid var(--border-glow)" }}>
        <div className="section-title">
          <div className="row">
             <Plus className="text-accent" size={20} />
             <h3>Register Ingress Rule</h3>
          </div>
        </div>
        <div className="form-row" style={{ marginTop: "1rem" }}>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">Local Handle (Service)</label>
            <select value={form.serviceId} onChange={(e) => setForm((p) => ({ ...p, serviceId: e.target.value }))}>
              {services.map((service) => (
                <option key={service.id} value={service.id}>{service.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">Public Endpoint (Domain)</label>
            <div className="row pr-overlap">
               <Globe size={18} className="icon-overlay muted" />
               <input 
                 className="with-icon"
                 placeholder="app.mycustomdomain.com" 
                 value={form.domain} 
                 onChange={(e) => setForm((p) => ({ ...p, domain: e.target.value }))} 
               />
            </div>
          </div>
          <div className="form-group" style={{ maxWidth: "160px" }}>
            <label className="tiny uppercase font-bold muted">Port Forward</label>
            <div className="row pr-overlap">
               <Hash size={18} className="icon-overlay muted" />
               <input 
                 className="with-icon"
                 type="number" 
                 placeholder="3000" 
                 value={form.targetPort} 
                 onChange={(e) => setForm((p) => ({ ...p, targetPort: e.target.value }))} 
               />
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: "2rem", justifyContent: "flex-end" }}>
           <button className="primary" onClick={() => void createRoute()}>
              <ArrowRightLeft size={18} /> Provision Rule
           </button>
        </div>
      </section>

      <div className="section-title">
         <div className="row">
            <Activity className="text-accent" size={18} />
            <h3>Active Ingress Rules</h3>
            <span className="badge accent">{routes.length}</span>
         </div>
      </div>

      <div className="grid">
        <AnimatePresence>
          {routes.length === 0 ? (
            <motion.div key="empty" className="card text-center" style={{ gridColumn: "1 / -1", padding: "6rem 2rem", opacity: 0.6 }}>
              <Globe size={60} className="muted" style={{ margin: "0 auto 1.5rem", opacity: 0.2 }} />
              <p className="muted font-bold">No active ingress rules detected.</p>
              <p className="tiny muted" style={{ maxWidth: "400px", margin: "1rem auto" }}>
                 Ingress rules map external DNS records to your private services running in the Survhub cluster.
              </p>
            </motion.div>
          ) : (
            routes.map((route) => (
              <motion.div 
                key={route.id} 
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="card service-card"
              >
                <div className="env-tag" style={{ border: "1.5px solid var(--info)", color: "var(--info)" }}>
                   <div className="row micro">
                      <Shield size={10} /> <span>SSL ACTIVE</span>
                   </div>
                </div>
                
                <div className="service-header" style={{ marginBottom: "1rem" }}>
                  <div className="row">
                     <Link2 size={18} className="text-accent" />
                     <h3 style={{ fontSize: "1.25rem" }}>{route.domain}</h3>
                  </div>
                </div>

                <div className="service-body" style={{ minHeight: "auto" }}>
                  <div className="route-mapping-box">
                    <div className="row small font-mono">
                      <span className="muted uppercase tiny font-bold">Local</span>
                      <span className="text-accent font-bold">127.0.0.1:{route.target_port}</span>
                    </div>
                  </div>
                  
                  <div className="row small" style={{ marginTop: "1rem" }}>
                    <Server size={14} className="muted" />
                    <span className="tiny font-bold uppercase muted">Target:</span>
                    <span className="small font-bold">{services.find((s) => s.id === route.service_id)?.name ?? "Dead Link"}</span>
                  </div>
                </div>

                <div className="service-footer" style={{ marginTop: "1.5rem", borderTop: "1px solid var(--border-subtle)" }}>
                  <button className="ghost text-danger xsmall" onClick={() => void deleteRoute(route)}>
                     <Trash2 size={14} /> Remove Rule
                  </button>
                  <a href={`http://${route.domain}`} target="_blank" rel="noreferrer" className="button ghost xsmall" style={{ marginLeft: "auto" }}>
                     <ExternalLink size={14} /> Open
                  </a>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
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
      `}} />
    </div>
  );
}
