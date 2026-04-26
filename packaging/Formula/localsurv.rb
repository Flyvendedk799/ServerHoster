class Localsurv < Formula
  desc "Self-hosted deploy platform for your own hardware"
  homepage "https://localsurv.dev"
  url "https://github.com/your-org/localsurv/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_SHA256_OF_THE_TARBALL"
  license "MIT"
  head "https://github.com/your-org/localsurv.git", branch: "main"

  depends_on "node@20"
  depends_on "git"
  depends_on "python@3.12" => :build # better-sqlite3 native addon
  depends_on "docker" => :optional

  def install
    # Install workspace deps and build every package
    system "npm", "ci"
    system "npm", "run", "build"

    # Copy compiled server + pruned prod deps into libexec
    libexec.install "apps/server/dist" => "server"
    libexec.install "apps/web/dist" => "web-dist"

    # Re-run install with only production deps so we don't ship dev tooling
    Dir.chdir(libexec) do
      system "npm", "init", "-y"
      system "npm", "install",
             "better-sqlite3",
             "dockerode",
             "fastify",
             "@fastify/cors",
             "@fastify/rate-limit",
             "acme-client",
             "http-proxy",
             "js-yaml",
             "nanoid",
             "selfsigned",
             "simple-git",
             "ws",
             "zod"
    end

    # Wrapper binary that launches the server with node from node@20
    (bin/"survhub").write <<~SHELL
      #!/usr/bin/env bash
      export SURVHUB_DATA_DIR="${SURVHUB_DATA_DIR:-$HOME/.survhub}"
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/server/cli.js" "$@"
    SHELL
  end

  service do
    run [opt_bin/"survhub", "start"]
    keep_alive true
    log_path var/"log/localsurv.log"
    error_log_path var/"log/localsurv.err.log"
  end

  def caveats
    <<~EOS
      LocalSURV has been installed.

      First run:
        survhub init
        set -a && source ~/.survhub/survhub.env && set +a
        survhub start

      Or run as a background service:
        brew services start localsurv

      Then open http://localhost:8787
    EOS
  end

  test do
    assert_match "survhub", shell_output("#{bin}/survhub --help")
  end
end
