# ---------- Stage 1: Build the NEXUS UI ----------
FROM node:22-alpine AS build

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy the rest of the source and build
COPY . .
RUN npm run build

# ---------- Stage 2: Serve with non-root nginx ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Custom nginx config (health endpoint + SPA fallback)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built app from the build stage
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 8080

USER 101

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1