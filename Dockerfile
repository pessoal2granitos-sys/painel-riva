FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

# O banco SQLite vive aqui. Em hospedagem, monte um disco persistente
# neste caminho — sem isso os dados somem a cada reinício.
RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
