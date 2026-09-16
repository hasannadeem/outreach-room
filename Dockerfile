# No build step: the app runs TypeScript directly through tsx, which is a runtime
# dependency here rather than a dev tool, so `npm ci --omit=dev` installs it at the
# version the lockfile pins.
FROM node:20-alpine

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

EXPOSE 3000
# Overridden per service in docker-compose.yml (api / worker / migrate).
CMD ["npx", "tsx", "src/server.ts"]
