import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
import { ensureDir } from "../lib/core.js";
import type { AppContext } from "../types.js";

export function buildHttpsTrustGuide(): Record<string, string[]> {
  return {
    windows: [
      "Open certlm.msc",
      "Import server-cert.pem into Trusted Root Certification Authorities",
      "Restart your browser"
    ],
    macos: [
      "Open Keychain Access",
      "Import server-cert.pem into System keychain",
      "Set trust to Always Trust and restart browser"
    ],
    linux: [
      "Copy server-cert.pem to /usr/local/share/ca-certificates/survhub.crt",
      "Run sudo update-ca-certificates",
      "Restart browser or shell"
    ]
  };
}

export function generateHttpsCerts(ctx: AppContext, commonName: string, altNames: string[]) {
  ensureDir(ctx.config.certsDir);
  const attrs = [{ name: "commonName", value: commonName }];
  const san = altNames.map((name) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(name) ? { type: 7, ip: name } : { type: 2, value: name }
  );
  const cert = selfsigned.generate(attrs, {
    days: 825,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: san }]
  });
  fs.writeFileSync(ctx.config.certPath, cert.cert);
  fs.writeFileSync(ctx.config.keyPath, cert.private);
  return {
    certPath: ctx.config.certPath,
    keyPath: ctx.config.keyPath,
    commonName,
    trustGuide: buildHttpsTrustGuide()
  };
}

export function getInstallScripts(ctx: AppContext) {
  ensureDir(ctx.config.scriptsDir);
  const linuxPath = path.join(ctx.config.scriptsDir, "install-systemd.sh");
  const macPath = path.join(ctx.config.scriptsDir, "install-launchd.sh");
  const winPath = path.join(ctx.config.scriptsDir, "install-windows-service.ps1");
  const linuxScript = `#!/usr/bin/env bash
set -euo pipefail
SERVICE_FILE=/etc/systemd/system/survhub.service
cat <<'EOF' | sudo tee $SERVICE_FILE >/dev/null
[Unit]
Description=SURVHub
After=network.target
[Service]
ExecStart=survhub server
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable survhub
sudo systemctl restart survhub
sudo systemctl status survhub --no-pager
`;
  const macScript = `#!/usr/bin/env bash
set -euo pipefail
PLIST=~/Library/LaunchAgents/com.survhub.server.plist
cat <<'EOF' > "$PLIST"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.survhub.server</string>
<key>ProgramArguments</key><array><string>survhub</string><string>server</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl unload "$PLIST" || true
launchctl load "$PLIST"
launchctl start com.survhub.server
`;
  const winScript = `sc.exe stop SURVHub
sc.exe delete SURVHub
sc.exe create SURVHub binPath= "survhub server" start= auto
sc.exe start SURVHub
sc.exe query SURVHub
`;
  fs.writeFileSync(linuxPath, linuxScript);
  fs.writeFileSync(macPath, macScript);
  fs.writeFileSync(winPath, winScript);
  return {
    linux: { path: linuxPath, script: linuxScript },
    macos: { path: macPath, script: macScript },
    windows: { path: winPath, script: winScript }
  };
}
