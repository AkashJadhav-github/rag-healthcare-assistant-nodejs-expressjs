# ============================================================
# Stage 1 — deps: install production dependencies only
# ============================================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

# ============================================================
# Stage 2 — build: full install + compile TypeScript
# ============================================================
FROM node:20-alpine AS build

WORKDIR /app

# Copy full source
COPY . .

# Install all dependencies (including devDependencies for build tools)
RUN npm ci

# Generate Prisma client (uses schema.prisma in ./prisma)
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ============================================================
# Stage 3 — runtime: lean production image
# ============================================================
FROM node:20-alpine AS runtime

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Copy Prisma schema + generated client (needed at runtime for migrations)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

# Copy package.json so Node can resolve the entry point
COPY package.json ./

# Run as non-root user (node is the built-in user in node:alpine)
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:3000/api/v1/health/live || exit 1

CMD ["node", "dist/server.js"]
