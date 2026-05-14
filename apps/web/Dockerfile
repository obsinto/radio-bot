FROM node:24-slim AS build

WORKDIR /app

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm install

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build -w @radio-bot/shared
RUN npm run build -w @radio-bot/web

FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/web apps/web

EXPOSE 4173
CMD ["npm", "run", "preview", "-w", "@radio-bot/web", "--", "--host", "0.0.0.0"]

