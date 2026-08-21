# NEXUS staging image (GOOD variant) ΓÇö Phase 3 Pass 5A.
#
# Serves the REAL, pre-built NEXUS UI (`npm run build` output in ./dist) on a
# minimal, NON-ROOT nginx runtime. Deliberately simple and deterministic:
#   ΓÇó no secrets, no build args carrying credentials
#   ΓÇó no host mounts, no Docker socket
#   ΓÇó runs as the unprivileged nginx user (uid 101), never root
#   ΓÇó listens on 8080 (NEXUS itself uses 3000; staging is reserved to 8080)
#
# Build (from the NEXUS workspace root, via the controlled HostBridge):
#   docker build -t nexus/nexus-app:<sha> .
#
# Requires ./dist to exist (run `npm run build` first). If dist/ is missing the
# COPY fails and the build honestly reports a non-zero exit code.

FROM nginxinc/nginx-unprivileged:1.27-alpine

# Health endpoint + SPA fallback (see nginx.conf). The unprivileged image
# already listens on 8080 and runs as the non-root nginx user.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Package the actual built application artifact.
COPY dist/ /usr/share/nginx/html/

EXPOSE 8080

# The base image defines a non-root USER and a healthcheck-friendly entrypoint;
# no override needed. Kept explicit for clarity.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
