# Builds any service: docker build --build-arg SERVICE=auth -t onebox/auth .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts
ARG SERVICE
RUN npx turbo run build --filter=./services/${SERVICE}

FROM node:24-alpine
ARG SERVICE
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services/${SERVICE}/package.json ./services/${SERVICE}/
RUN npm ci --omit=dev --ignore-scripts --workspace=./services/${SERVICE} && npm cache clean --force
COPY --from=build /app/services/${SERVICE} ./services/${SERVICE}
WORKDIR /app/services/${SERVICE}
USER node
CMD ["node", "dist/main.js"]
