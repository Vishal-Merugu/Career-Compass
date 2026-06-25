FROM node:20

WORKDIR /app

# Copy dependency configuration files
COPY package*.json ./

# Install npm dependencies
RUN npm ci --verbose

# Copy the rest of the application files
COPY . .

# Generate Prisma Client classes
RUN npx prisma generate

# Compile TypeScript to JavaScript
RUN npm run build

EXPOSE 3000

# Run migrations/pushes and start the server
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
