FROM node:18-alpine

# FFmpeg for server-side video conversion
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install deps first (layer-cached until package.json changes)
COPY package*.json ./
RUN npm ci --production

COPY . .

# Temp upload dir (also created at runtime by server.js, but good to have it ready)
RUN mkdir -p /tmp/hear-uploads

EXPOSE 3000
CMD ["node", "server.js"]
