FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tick-worker.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "tick-worker.js"]
