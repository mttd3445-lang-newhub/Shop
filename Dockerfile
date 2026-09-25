FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["npm", "start"]
