FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# dev packages (vite) are needed for the build, dropped after it
RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build && npm prune --omit=dev

CMD ["npm", "run", "docker-start"]
