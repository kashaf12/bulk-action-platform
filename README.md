# Bulk Action Platform

A robust and scalable platform for performing **bulk actions** (e.g., on contacts, products, orders). Designed to handle large datasets asynchronously using a **microservices-like architecture**, ensuring high performance and responsiveness.

---

## 🚀 Architecture Overview

The platform comprises multiple interconnected services built for scalability and resilience:

- **API Service**: Handles HTTP requests, user authentication, file uploads, and initiates workflows.
- **Chunking Worker**: Processes uploaded files (e.g., CSV), validates and deduplicates records, then chunks them.
- **Processing Worker**: Applies business logic on data chunks and updates action statistics.
- **PostgreSQL**: Stores bulk action metadata, statistics, and entity records.
- **Redis**: Manages message queues (via BullMQ) and optionally caching.
- **MinIO**: Stores raw files and chunked data (S3-compatible object storage).

> **Key Benefit**: Long-running bulk operations are processed asynchronously, ensuring responsiveness and horizontal scalability.

---

## ✨ Key Features

- **Scalable Bulk Processing** via asynchronous workers and chunking
- **CSV Uploads** with secure storage (MinIO)
- **Redis Queues** for background job management (BullMQ)
- **Validation & Deduplication** during chunking
- **Real-time Progress Tracking** and action statistics
- **Entity Extensibility**: Easily add support for new data models
- **Health Monitoring**: Built-in health check endpoints

---

## 🛠️ Tech Stack

- **Backend**: Node.js, TypeScript, Express.js
- **Database**: PostgreSQL
- **Queue/Cache**: Redis + BullMQ
- **Storage**: MinIO (S3-compatible)
- **Validation**: Zod
- **Testing**: Jest
- **Linting/Formatting**: ESLint, Prettier
- **Containerization**: Docker, Docker Compose

---

## 🚀 Getting Started

### ✅ Prerequisites

Ensure the following are installed:

- [Docker](https://www.docker.com/)
- [Docker Compose](https://docs.docker.com/compose/)
- [Node.js](https://nodejs.org/) (v18+)
- npm (bundled with Node.js)

### 🔧 Installation

```bash
git clone git@github.com:kashaf12/bulk-action-platform.git
cd bulk-action-platform
npm install
cp .env.example .env
```

> Modify `.env` if needed; defaults work for local development.

### ▶️ Run Application

```bash
docker-compose up --build -d
```

This will:

- Build Docker images
- Start PostgreSQL, Redis, MinIO
- Run DB migrations and seed data (if defined)
- Start API, chunking, and processing workers

API available at: [http://localhost:3000](http://localhost:3000)

### 🛑 Stop Application

```bash
docker-compose down        # Stop containers
docker-compose down -v     # Stop + remove volumes
```

---

## 📜 Available npm Scripts

| Command                           | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `npm run build`                   | Compile TypeScript to JavaScript                       |
| `npm start`                       | Start API server (after build)                         |
| `npm run dev`                     | Start API server in dev mode (ts-node-dev)             |
| `npm run start:chunking`          | Start chunking worker                                  |
| `npm run start:processing`        | Start processing worker                                |
| `npm run dev:chunking`            | Chunking worker in dev mode                            |
| `npm run dev:processing`          | Processing worker in dev mode                          |
| `npm test`                        | Run all Jest tests                                     |
| `npm run test:watch`              | Jest in watch mode                                     |
| `npm run test:coverage`           | Test with coverage report                              |
| `npm run clean`                   | Remove `dist` directory                                |
| `npm run lint` / `lint:fix`       | Lint code / auto-fix                                   |
| `npm run format` / `format:check` | Format code / check format                             |
| `npm run type-check`              | TypeScript check without build                         |
| `npm run docker:*`                | Docker helpers for build, up, down, api, workers, seed |

---

## ⚙️ Environment Variables

Configure via `.env`. Reference: `.env.example`.

| Variable                        | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `PORT`                          | API port (default: 3000)                            |
| `NODE_ENV`                      | Environment (development, production, test)         |
| `DATABASE_URL`                  | PostgreSQL connection string                        |
| `REDIS_URL`                     | Redis connection string                             |
| `MINIO_*`                       | MinIO config (host, port, credentials, bucket name) |
| `JWT_SECRET`                    | Secret for JWT signing/verification                 |
| `RATE_LIMIT_*`                  | API rate-limiting config                            |
| `MAX_FILE_SIZE_MB`              | Max upload file size (in MB)                        |
| `MAX_CSV_ROWS`                  | Max rows per uploaded CSV                           |
| `CHUNK_SIZE`                    | Records per processing chunk                        |
| `PRE_SIGNED_URL_EXPIRY_SECONDS` | MinIO signed URL expiry                             |

---

## ➕ Adding New Entities

To support a new entity (e.g., `Product`, `Order`):

1. **DB Schema**: Define new tables in `docker/postgres/init/`
2. **Model**: Create model class in `src/models/`
3. **Types**: Define interfaces in `src/types/entities/`
4. **Validation**: Add Zod schemas in `src/schemas/entities/`
5. **Repository**: Implement repository in `src/repositories/`
6. **Service Logic**: Add business logic in `src/services/`
7. **API Routes** _(optional)_: Add endpoints in `src/api/`
8. **Worker Logic**: Extend chunking/processing in `src/workers/` and `src/processors/csv/`

Refer to the `Contact` entity implementation for examples.

---

## 🌐 API Endpoints

All responses follow a consistent JSON structure.

### 🔍 Health Checks

| Method | Endpoint                                   |
| ------ | ------------------------------------------ |
| `GET`  | `/health` - Basic health check             |
| `GET`  | `/health/detailed` - Includes dependencies |
| `GET`  | `/health/ready` - Readiness probe          |
| `GET`  | `/health/live` - Liveness probe            |

### 📦 Bulk Actions

| Method | Endpoint                                        |
| ------ | ----------------------------------------------- |
| `POST` | `/bulk-actions` - Upload CSV + create action    |
| `GET`  | `/bulk-actions` - List bulk actions (paginated) |
| `GET`  | `/bulk-actions/:id` - View action details       |

### 📈 Statistics

| Method | Endpoint                                         |
| ------ | ------------------------------------------------ |
| `GET`  | `/bulk-actions/:id/stats` - View action progress |

> For detailed API contract, refer to the **API Endpoint Documentation** section in the main documentation.

---

## 🤝 Contributing

Contributions welcome! Feel free to open issues or PRs to help improve the platform.

---

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.
