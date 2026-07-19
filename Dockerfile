# Universo — production image.
#
# Runtime data (accounts, clicks, events, photo cache) is written to
# UNIVERSO_DATA_DIR — mount a persistent volume there, NOT at /app/data,
# or the seed files baked into this image would be hidden by the mount.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so code changes don't bust the dependency layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Runtime data lives on the mounted volume; created at boot if empty.
ENV UNIVERSO_DATA_DIR=/data
VOLUME /data

EXPOSE 3000
# Direct node (no npm wrapper) so SIGTERM reaches the graceful-shutdown handler.
CMD ["node", "server.js"]
