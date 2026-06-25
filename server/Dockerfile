FROM node:20-slim

WORKDIR /app

# Tell Puppeteer to skip downloading the massive Chromium binary
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy dependency configuration files
COPY package*.json ./

# Install npm dependencies
RUN npm ci

# Copy the rest of the application files
COPY . .

# Generate Prisma Client classes
RUN npx prisma generate

# Compile TypeScript to JavaScript
RUN npm run build

EXPOSE 3000

# Run migrations/pushes and start the server
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
