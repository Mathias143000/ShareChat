FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.client.json tsconfig.server.json ./
COPY types ./types
COPY src ./src
COPY public ./public
COPY allowed_ips.txt VERSION ./

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/types ./types
COPY --from=build --chown=node:node /app/allowed_ips.txt ./allowed_ips.txt
COPY --from=build --chown=node:node /app/VERSION ./VERSION

RUN mkdir -p /app/data /app/uploads && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "dist/index.js"]
