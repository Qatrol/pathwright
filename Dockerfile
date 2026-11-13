FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p storage/cache storage/sessions storage/projects storage/logs \
  && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=5555
EXPOSE 5555

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:5555/health || exit 1

CMD ["node", "server.js"]
