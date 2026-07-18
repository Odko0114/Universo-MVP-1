# Universo — production image.
#
# Runtime data (accounts, clicks, events, photo cache) is written to
# UNIVERSO_DATA_DIR — mount a persistent volume there, NOT at /app/data,
# or the seed files baked into this image would be hidden by the mount.
#
# Two stages: the first builds the /join React page (needs devDependencies —
# Vite, Tailwind — that have no reason to exist in the runtime image); the
# second is the actual server image, with only production dependencies and
# the already-built static output.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY join-app/package.json join-app/package-lock.json ./join-app/
RUN npm --prefix join-app ci
COPY . .
RUN npm run build:join

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY data ./data
COPY public ./public
COPY --from=build /app/public/join ./public/join

# Runtime data lives on the mounted volume; created at boot if empty.
ENV UNIVERSO_DATA_DIR=/data
VOLUME /data

EXPOSE 3000
# Direct node (no npm wrapper) so SIGTERM reaches the graceful-shutdown handler.
CMD ["node", "server.js"]
