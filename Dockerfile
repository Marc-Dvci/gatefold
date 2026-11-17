# The Gatefold site, built and served as static files. No keys: it reads X Layer through the public node.
#   docker compose up        http://localhost:8080

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts vite.embed.config.ts ./
COPY src/ src/
COPY web/ web/
COPY songs/ songs/
COPY deployments/ deployments/
RUN npx vite build && npx vite build --config vite.embed.config.ts

FROM nginxinc/nginx-unprivileged:1.27-alpine AS demo
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
