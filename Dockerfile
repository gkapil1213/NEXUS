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
FROM nginx:stable-alpine
RUN apk upgrade --no-cache
RUN mkdir -p /var/cache/nginx/client_temp /var/run/nginx /var/log/nginx && chown -R 101:101 /var/cache/nginx /var/run/nginx /var/log/nginx
RUN touch /run/nginx.pid && chown 101:101 /run/nginx.pid

# Custom nginx config (health endpoint + SPA fallback)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built app from the build stage
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 8080

USER 101

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
