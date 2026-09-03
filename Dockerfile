# Immagine unica: serve l'app e il relay online sulla stessa porta.
FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/server.js"]
