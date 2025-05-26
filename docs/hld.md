# High-Level Design: Advanced Bulk Action Flow

## Overview

## This document presents a refined and horizontally scalable design for a **Bulk Action Processing System** that handles bulk operations like updating contact data using large CSV files. It ensures efficient streaming, chunking, and distributed processing with high throughput and fault tolerance.

## Core Entities

### 1. **Contact**

Represents the entity to be updated in bulk (e.g., user records).

### 2. **Bulk Action**

Captures metadata and operation intent initiated by the user.

### 3. **Bulk Action Stat**

Tracks granular statistics for each bulk operation such as total records, failed, and successful updates.

---

## API Design

### Endpoints

```http
GET  /bulk-actions                  → Action[]
GET  /bulk-actions/{actionId}       → Action
GET  /bulk-actions/{actionId}/stat  → ActionStat
POST /bulk-actions     → Initiates a bulk update
```

### Request Body for `POST /bulk-actions`

```json
{
  "file": File(csv),
  "actionType": "bulk_update",
  "entityType": "contact"
}
```

---

## Data Flow

### 1. **Client**

- Uploads CSV containing bulk data (e.g., contacts).
- Can poll the API to get the status and results of actions.

---

## 2. **Server (API Gateway)**

Responsible for:

- **Validation** of uploaded file and metadata.
- **Authentication**
- **Rate Limiting**
- **Sanitization** of incoming data.
- **Tracing** with `traceId` for observability.

Streams the CSV to **S3** and then queues a chunking job.

---

## 3. **S3 (Blob Storage)**

- Receives the streamed CSV file.
- Acts as a persistent store for chunked data (chunks of 1000 rows).

---

## 4. **Chunking Queue**

Handles the job that splits the file into manageable pieces.

---

## 5. **Chunking Worker**

Responsibilities:

- Reads the CSV file from S3.
- Splits it into **chunks of 1000 rows**.
- Stores each chunk back to S3.
- Each chunk job is hashed using **consistent hashing** to distribute work evenly across processing workers.

Then, it sends jobs to the **Ingestion Queue**.

---

## 6. **Ingestion Queue (BullMQ)**

Handles chunk ingestion with a design to **partition based on worker index**. This reduces race conditions and allows workers to process data deterministically.

---

## 7. **Processing Worker**

This is the critical path of the system:

- Fetches chunk data from S3.
- Parses and applies business logic (e.g., updating contacts).
- Writes results in **batched DB operations** for performance.
- Reports success/failure counts per chunk.
- Horizontally scalable: multiple workers can be run to increase throughput.

---

## 8. **Database**

### Tables

#### `bulk_actions`

| Field      | Description                     |
| ---------- | ------------------------------- |
| id         | UUID                            |
| actionType | e.g., `bulk_update`             |
| entityType | e.g., `contact`                 |
| accountId  | Account initiating the action   |
| metadata   | Any contextual or business data |

#### `bulk_action_stats`

| Field    | Description                       |
| -------- | --------------------------------- |
| id       | UUID                              |
| actionId | FK to bulk_actions                |
| total    | Total records intended to process |
| failed   | Failed record count               |
| success  | Successful record count           |
| metadata | Additional information            |

---

## System Characteristics

### ⚙️ Observability

- Every request and job carries a `traceId`.
- Metrics emitted at each stage (chunking, ingestion, processing).
- Status endpoint provides real-time progress tracking.

### ⚙️ Scalability

- **Chunking** and **processing** workers can scale horizontally.
- Partitioning and consistent hashing ensure efficient worker allocation.
- Jobs are idempotent to allow retries without side effects.

### ⚙️ Reliability

- CSV is streamed directly to S3: avoids memory overflow.
- Processing is done in batches: ensures partial progress is not lost.
- Designed for **eventual consistency** but reliable processing.

---

## Sequence Flow Summary

1. **Client → Server**: Upload CSV & metadata.
2. **Server → S3**: Stream file.
3. **Server → Chunking Queue**: Initiate chunking job.
4. **Chunking Worker**: Read CSV → create chunks → store to S3 → hash & emit ingestion jobs.
5. **Ingestion Queue**: Hold ingestion jobs partitioned for workers.
6. **Processing Worker**: Poll job → fetch chunk → apply business logic → update DB.
7. **Client → Server**: Query status/statistics of bulk job.

---

## Trade-offs

| Aspect          | Trade-off                                     |
| --------------- | --------------------------------------------- |
| Latency         | Sacrificed for high throughput and batching   |
| Complexity      | Higher due to distributed worker architecture |
| Consistency     | Eventual; updates reflected after some delay  |
| Fault tolerance | Retryable jobs but needs dead-letter support  |

---

## Future Enhancements

- **Dead-letter queue** support for jobs that consistently fail.
- **Row-level error logging** with downloadable CSV error reports.
- WebSocket support for **live progress updates**.
- Granular **RBAC-based permission** on bulk actions.
- Streaming data processing
- Dynamic scaling
