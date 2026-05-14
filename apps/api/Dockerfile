FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json

RUN npm install

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build -w @radio-bot/shared
RUN npm run build -w @radio-bot/api

FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/api apps/api

EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@radio-bot/api"]

