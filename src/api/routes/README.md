# API Routes Documentation

## Available Endpoints

### Bulk Actions

- `POST /bulk-actions` - Create bulk action with CSV upload
- `GET /bulk-actions` - List bulk actions with filtering
- `GET /bulk-actions/{actionId}` - Get bulk action details
- `GET /bulk-actions/{actionId}/stats` - Get bulk action statistics
- `PUT /bulk-actions/{actionId}/cancel` - Cancel bulk action
- `GET /bulk-actions/{actionId}/logs` - Get bulk action logs (future)

### Health Checks

- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed health with dependencies
- `GET /health/ready` - Kubernetes readiness probe
- `GET /health/live` - Kubernetes liveness probe

### General

- `GET /` - API information and available endpoints
- `GET /docs` - API documentation (future)

## Middleware Chain Order

1. **Security Headers** (Helmet)
2. **CORS Configuration**
3. **Global Rate Limiting**
4. **Body Parsing**
5. **Request Sanitization**
6. **Tracing** (per route)
7. **Authentication** (per route)
8. **Endpoint-specific Rate Limiting** (bulk actions only)
9. **File Upload** (bulk action creation only)
10. **Validation** (per route)
11. **Audit Logging** (sensitive operations)
12. **Controller Logic**
13. **Error Handling** (global)

## Security Features

- Helmet for security headers
- CORS with configurable origins
- Rate limiting (global + endpoint-specific)
- Request sanitization
- File upload security
- CSV content validation
- Authentication via headers
- Audit logging for sensitive operations
