import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.cwd());
const port = Number(process.env.PORT || process.argv[2] || 8080);

// COOP/COEP cross-origin isolation is required for SharedArrayBuffer (Godot web
// exports) but BREAKS ordinary SPAs: `require-corp` blocks cross-origin images,
// fonts and scripts that don't send a CORP header. Only emit the isolation
// headers when the directory actually looks like a Godot export (.pck present).
const crossOriginIsolate = (() => {
  try {
    return fs.readdirSync(root).some((name) => name.endsWith(".pck"));
  } catch {
    return false;
  }
})();

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  // SEO files are strict about their type: Google only parses robots.txt when
  // it is served as text/plain, and a sitemap sent as application/octet-stream
  // is liable to be rejected outright.
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

function safePath(urlPath: string): string {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const candidate = path.resolve(root, `.${decoded}`);
  if (!candidate.startsWith(root)) return root;
  return candidate;
}

http
  .createServer((req, res) => {
    let filePath = safePath(req.url ?? "/");
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath) && fs.existsSync(path.join(root, "index.html"))) {
      filePath = path.join(root, "index.html");
    }

    if (crossOriginIsolate) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`Serving ${root} on http://0.0.0.0:${port}`);
  });
