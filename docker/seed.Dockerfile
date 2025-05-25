# Seed Service Dockerfile
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache curl postgresql-client

# Install only production deps (faker & pg should be listed in package.json under dependencies)
RUN npm install @faker-js/faker pg uuid

# Copy seed script
COPY scripts/seed-database.js ./seed-database.js

# Create wait script for database readiness
RUN echo '#!/bin/sh' > wait-for-db.sh && \
    echo 'echo "Waiting for PostgreSQL to be ready..."' >> wait-for-db.sh && \
    echo 'until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER"; do' >> wait-for-db.sh && \
    echo '  echo "PostgreSQL is unavailable - sleeping..."' >> wait-for-db.sh && \
    echo '  sleep 2' >> wait-for-db.sh && \
    echo 'done' >> wait-for-db.sh && \
    echo 'echo "PostgreSQL is up - executing seeding..."' >> wait-for-db.sh && \
    echo 'exec node seed-database.js' >> wait-for-db.sh

# Make script executable
RUN chmod +x wait-for-db.sh

# Set environment
ENV NODE_ENV=production

# Run the wait-for-db script
ENTRYPOINT ["./wait-for-db.sh"]
