# Avoid Nixpacks/mise downloading Node during build (often fails with "connection reset").
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
