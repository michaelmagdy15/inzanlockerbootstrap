# Use a lightweight official Node image
FROM node:20-alpine

# Set environment
ENV NODE_ENV=production

# Set working directory
WORKDIR /usr/src/app

# Copy dependency definition
COPY package*.json ./

# Install production-only dependencies
RUN npm ci --only=production

# Copy application source files
COPY server.js ./
COPY database.js ./
COPY lockers_config.json ./
COPY public/ ./public/

# Expose default port
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
