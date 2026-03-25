import { useEffect, useState } from "react";
import { api } from "../lib/api";

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
  const [form, setForm] = useState({ serviceId: "", domain: "", targetPort: "" });

  async function load(): Promise<void> {
    const [routeRows, serviceRows] = await Promise.all([api<RouteRow[]>("/proxy/routes"), api<Service[]>("/services")]);
    setRoutes(routeRows);
    setServices(serviceRows);
    if (!form.serviceId && serviceRows.length > 0) {
      setForm((p) => ({ ...p, serviceId: serviceRows[0].id }));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createRoute(): Promise<void> {
    await api("/proxy/routes", {
      method: "POST",
      body: JSON.stringify({
        serviceId: form.serviceId,
        domain: form.domain,
        targetPort: Number(form.targetPort)
      })
    });
    setForm((p) => ({ ...p, domain: "", targetPort: "" }));
    await load();
  }

  async function deleteRoute(routeId: string): Promise<void> {
    await api(`/proxy/routes/${routeId}`, { method: "DELETE" });
    await load();
  }

  return (
    <section>
      <h2>Proxy Routes</h2>
      <div className="card form">
        <h3>Create route</h3>
        <select value={form.serviceId} onChange={(e) => setForm((p) => ({ ...p, serviceId: e.target.value }))}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        <input placeholder="Domain (example.localhost)" value={form.domain} onChange={(e) => setForm((p) => ({ ...p, domain: e.target.value }))} />
        <input placeholder="Target Port" value={form.targetPort} onChange={(e) => setForm((p) => ({ ...p, targetPort: e.target.value }))} />
        <button onClick={() => void createRoute()}>Create route</button>
      </div>

      <div className="grid">
        {routes.map((route) => (
          <div key={route.id} className="card">
            <h3>{route.domain}</h3>
            <p>Port: {route.target_port}</p>
            <p>Service: {services.find((service) => service.id === route.service_id)?.name ?? route.service_id}</p>
            <button onClick={() => void deleteRoute(route.id)}>Delete</button>
          </div>
        ))}
      </div>
    </section>
  );
}
