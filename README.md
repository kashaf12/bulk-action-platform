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
- **Resumable Processing**: Fault-tolerant worker orchestration
- **Metrics & Logging**: Support for tracing and Loki-compatible logging
- **Rate Limiting**: Per-account protection using Redis-backed throttling

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
- **Observability**: Winston, Loki (logging), Grafana, custom health endpoints

---

## 🔍 Tooling

- `ts-node-dev` for live reloading during development
- `csv-parser` for fast CSV streaming
- `faker.js` for synthetic data generation
- `pg`, `multer`, `minio`, `bullmq` for DB, file, queue integrations
- `@faker-js/faker`, `csv-writer`, and custom seeding scripts
- Scripts to seed, generate, and simulate contacts and bulk actions

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
npm run docker:up
```

This will:

- Build Docker images
- Start PostgreSQL, Redis, MinIO
- Run DB migrations and seed data (if defined)
- Start API, chunking, and processing workers

API available at: [http://localhost:3000](http://localhost:3000)

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
| `npm run lint` / `lint:fix`       | Lint code / auto-fix                                   |
| `npm run format` / `format:check` | Format code / check format                             |
| `npm run type-check`              | TypeScript check without build                         |
| `npm run docker:*`                | Docker helpers for build, up, down, api, workers, seed |

---

## ⚙️ Environment Variables

Configure via `.env`. Reference: `.env.example`.

| Variable           | Description                                         |
| ------------------ | --------------------------------------------------- |
| `PORT`             | API port (default: 3000)                            |
| `NODE_ENV`         | Environment (development, production, test)         |
| `DATABASE_URL`     | PostgreSQL connection string                        |
| `REDIS_URL`        | Redis connection string                             |
| `MINIO_*`          | MinIO config (host, port, credentials, bucket name) |
| `JWT_SECRET`       | Secret for JWT signing/verification                 |
| `RATE_LIMIT_*`     | API rate-limiting config                            |
| `MAX_FILE_SIZE_MB` | Max upload file size (in MB)                        |
| `MAX_CSV_ROWS`     | Max rows per uploaded CSV                           |
| `CHUNK_SIZE`       | Records per processing chunk                        |

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

---

## 🔧 Future Improvements

These enhancements aim to elevate the platform’s resilience, developer experience, and production readiness.

---

- [ ] **Auto-scale Worker Containers via Metrics**
      Introduce horizontal auto-scaling for chunking and processing workers using orchestration platforms like Kubernetes. Use Redis queue depth, CPU, or memory metrics to scale containers dynamically during load spikes.

---

- [ ] **Add More Robust Retrying for Failed Chunks**
      While a basic retry mechanism exists, it can be improved with:

  - Persistent retry queue or DLQ
  - Retry limits with circuit-breaker support
    This will improve fault tolerance for transient issues like DB timeouts or network failures.

---

- [ ] **Add OpenAPI / Swagger Documentation**
      Generate interactive API documentation using tools like `swagger-jsdoc` and `swagger-ui-express` to help developers understand and consume APIs easily.

---

- [ ] **Better Logging with Grafana Dashboards**
      Extend current Grafana integration by visualizing:

  - Action throughput
  - Error rates
  - Queue depth per worker
    Enhance logs with structured formats and searchable tags using Loki.

---

- [ ] **Better Folder Structure (More Modular & Extensible)**
      Refactor the codebase to group features and entities logically:

  ```
  src/
    └─ modules/
        ├─ contacts/
        ├─ leads/
        ├─ common/
  ```

  This ensures scalability as new entities or actions are added.

---

- [ ] **Code Modularity**
      Extract common logic (e.g., chunk splitting, job lifecycle management, CSV parsing) into reusable services or utilities to reduce duplication and make onboarding easier for future contributors.

---

- [ ] **Custom Artillery Script for Load Testing**
      Develop reproducible load test scenarios using [Artillery](https://artillery.io/) or [k6](https://k6.io/) to validate:

  - Upload throughput
  - Worker load balancing
  - Rate limiting behavior

---

- [ ] **Detailed Log Endpoint (Beyond Grafana)**
      Expose an authenticated API endpoint (e.g., `GET /bulk-actions/:id/logs`) to fetch per-row processing logs with status (success, failed, skipped) and reasons. Enables log visibility without requiring Grafana access.

---

- [ ] **Separate Dockerfile for Production and Development**
      Split Dockerfiles to optimize for context:

  - **Dev Dockerfile**: Includes hot-reloading, debugging tools, and volume mounts
  - **Prod Dockerfile**: Stripped down, prebuilt TypeScript, smaller image footprint, and stricter ENV handling

---

## 📬 Postman Collection

You can test the complete set of APIs using the provided Postman collection:

🔗 **Postman Collection**: [`docs/postman/postman_collection.json`](./docs/postman/postman_collection.json)

🔗 **Postman Environment**: [`docs/postman/postman_environment.json`](./docs/postman/postman_environment.json)

### 🛠️ How to Use:

1. Open Postman.
2. Click `Import`.
3. Upload or paste the path to the collection file:
   `docs/postman/postman_collection.json`
4. Upload or paste the path to the environment file:
   `docs/postman/postman_environment.json`

---

## 📈 Mermaid Graph

All architecture and data flow diagrams are written in [Mermaid.js](https://mermaid.js.org/), stored in the `mermaid/` folder.

### 📁 Location

- Mermaid files live in `./docs/graph/*.mmd`

### ▶️ How to Render Mermaid Diagrams

#### Online Editor

1. Visit [Mermaid Live Editor](https://mermaid.live)
2. Copy-paste content of `.mmd` files to view and export.

---

## 🖼️ Screenshots

Structured breakdown of screenshots and diagrams for quick reference.

---

### 🌐 API Screenshots

#### 📁 `docs/screenshots/api/bulk-action/`

- [deduplicate_w_scheduledAt.png](./docs/screenshots/api/bulk-action/deduplicate_w_scheduledAt.png)
- [get.png](./docs/screenshots/api/bulk-action/get.png)
- [list.png](./docs/screenshots/api/bulk-action/list.png)
- [post.png](./docs/screenshots/api/bulk-action/post.png)
- [rate-limit.png](./docs/screenshots/api/bulk-action/rate-limit.png)
- [scheduledAt.png](./docs/screenshots/api/bulk-action/scheduledAt.png)
- [stats.png](./docs/screenshots/api/bulk-action/stats.png)

#### 📁 `docs/screenshots/api/docs/`

- [docs.png](./docs/screenshots/api/docs/docs.png)

#### 📁 `docs/screenshots/api/health/`

- [health.png](./docs/screenshots/api/health/health.png)
- [detailed.png](./docs/screenshots/api/health/detailed.png)
- [live.png](./docs/screenshots/api/health/live.png)
- [ready.png](./docs/screenshots/api/health/ready.png)

#### 📁 `docs/screenshots/api/root/`

- [root.png](./docs/screenshots/api/root/root.png)
- [structure.png](./docs/screenshots/api/root/structure.png)

---

### 🧱 HLD (High-Level Design)

#### 📁 `docs/screenshots/hld/`

- [HLD.png](./docs/screenshots/hld/HLD.png)
- [HLD.svg](./docs/screenshots/hld/HLD.svg)

---

### 🧠 Detailed HLD

#### 📁 `docs/screenshots/detailed-hld/`

- [mermaid.png](./docs/screenshots/detailed-hld/mermaid.png)

---

### 🔁 Diagram Flows

#### 📁 `docs/screenshots/diagram-flow/`

- [bulk-action-list-flow.png](./docs/screenshots/diagram-flow/bulk-action-list-flow.png)
- [bulk-action-post-flow.png](./docs/screenshots/diagram-flow/bulk-action-post-flow.png)
- [bulk-action-stats-flow.png](./docs/screenshots/diagram-flow/bulk-action-stats-flow.png)
- [flow.png](./docs/screenshots/diagram-flow/flow.png)
- [health-flow.png](./docs/screenshots/diagram-flow/health-flow.png)

---

### ⚙️ Docker

#### 📁 `docs/screenshots/docker/`

- [containers.png](./docs/screenshots/docker/containers.png)
- [volumes.png](./docs/screenshots/docker/volumes.png)

---

### 📊 Grafana

#### 📁 `docs/screenshots/grafana/`

- [filter.png](./docs/screenshots/grafana/filter.png)
- [logs.png](./docs/screenshots/grafana/logs.png)

---

### 🗃️ MinIO

#### 📁 `docs/screenshots/minio/`

- [store.png](./docs/screenshots/minio/store.png)

---

### 🗃️ PgAdmin

#### 📁 `docs/screenshots/pg/`

- [bulk-actions.png](./docs/screenshots/pg/bulk-actions.png)
- [bulk-action-stats.png](./docs/screenshots/pg/bulk-action-stats.png)
- [contacts.png](./docs/screenshots/pg/contacts.png)
- [tables.png](./docs/screenshots/pg/tables.png)

---

## ✅ Bulk Action Platform Assignment – Feature Checklist

| Feature Category              | Requirement                                              | Status         | Notes                                                  |
| ----------------------------- | -------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| **Core Functionality**        | Bulk Update for a single entity (Contact)                | ✅ Implemented | Contact entity used with fields like name, email       |
|                               | Support for updating multiple fields (name, email, etc.) | ✅ Implemented | Validated via CSV uploads                              |
|                               | Batch Processing                                         | ✅ Implemented | Chunking worker processes files in batches             |
| **Entities**                  | Entity-agnostic architecture                             | ✅ Implemented | Designed to easily support future entities             |
| **Performance & Scalability** | Handle thousands to a million entities                   | ✅ Implemented | Chunking + workers + MinIO tested with up to 100k rows |
|                               | Horizontal scaling support                               | ✅ Implemented | Dockerized workers support horizontal scaling          |
| **Logging & Stats**           | Success, failure, skipped logs per entity                | ✅ Implemented | Logged per row, via worker stats                       |
|                               | API for summary stats                                    | ✅ Implemented | `/bulk-actions/:id/stats` returns counts               |
| **Status & Progress**         | Ongoing, completed, queued status                        | ✅ Implemented | Status tracked per action                              |
|                               | Real-time progress                                       | ✅ Implemented | API provides progressive stats                         |
|                               | Logs accessible (UI optional)                            | ✅ Implemented | Logs viewable via Grafana, log files available         |
| **Extensibility**             | Code reusability                                         | ✅ Implemented | Schema validation, chunking, processing are modular    |
| **API & Documentation**       | Postman Collection                                       | ✅ Implemented | Available in `/postman` folder                         |
|                               | API Documentation                                        | ✅ Implemented | Covered in `README.md` and `/docs/endpoints.md`        |
|                               | Loom Video                                               | ✅ Completed   | To be included before final submission                 |
| **Optional Enhancements**     | Rate Limiting per account                                | ✅ Implemented | `BULK_ACTION_RATE_LIMIT` using Redis                   |
|                               | Deduplication by email                                   | ✅ Implemented | Skipped entities marked and logged                     |
|                               | Scheduled Bulk Actions                                   | ✅ Implemented | `scheduledAt` field supported and honored in worker    |

---

## 📊 Summary

| Category                  | Implemented | Partial | Not Done |
| ------------------------- | ----------- | ------- | -------- |
| **Core Requirements**     | ✅ 13       | ⚠️ 0    | ❌ 0     |
| **Optional Enhancements** | ✅ 3        | ⚠️ 0    | ❌ 0     |
| **Docs & Deliverables**   | ✅ 3        | ⚠️ 0    | ❌ 0     |
