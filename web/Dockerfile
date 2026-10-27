# Stage 1: build the React app. Stage 2: nginx serves it AND is the single
# public entry point that routes /api/* to the services.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install
COPY . .
ARG VITE_CURRENCY=NGN
ENV VITE_CURRENCY=$VITE_CURRENCY
RUN pnpm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
