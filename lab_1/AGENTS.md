# AGENTS.md

Java 17 / Spring Boot 3.2.5 microservices platform. Maven multi-module build (`mvn` at repo root). Group `ru.itmo.taskmanager`.

## Modules & ports
- `common` — shared: `ErrorCode` enum, `ErrorResponse` envelope, permission-check DTOs, validation/date utils. Depended on by all services; never a standalone app.
- `user-service` (8081) — auth, users, JWT. Plain web service (no cross-service clients; it has no `client/` package).
- `project-service` (8082) — projects + membership RBAC.
- `task-service` (8083) — tasks, tags, comments, attachments.
- `ui-client` — Java Swing desktop client (single large file, not a service).

Services (except user-service) call each other via RestTemplate classes in each service's `client/` package, with URLs injected via `@Value("${services.<x>-service.url:http://localhost:PORT}")`. Dependency graph (services:8082→user:8081, project:8082→task:8083, task:8083→project:8082).

## Commands
- All tests: `mvn test`
- Build (includes tests, matches CI): `mvn -B package`
- Single module: `mvn test -pl user-service` (add `-am` to build upstream `common` first)
- Tests are JUnit 5 with Mockito. CI runs on GitHub Actions (JDK 17 Temurin), triggers on `main`/`develop`.

## Conventions (deviate only with good reason)
- **Dual implementation**: every service has both `Jpa*Service` (annotated `@Primary`, DB-backed) behind an interface `*Service`, and a `Mock*Service` storing data in-memory (`ConcurrentHashMap`). Implement feature changes in BOTH and keep behavior parallel. Unit tests exercise the Mock implementations — construct them directly and mock the `client/` collaborators.
- **Error handling**: business errors are thrown as `new IllegalArgumentException("<ERROR_CODE_STRING>")` e.g. `"INSUFFICIENT_PERMISSIONS"`, `"DUPLICATE_EMAIL"` (values mirror `common/.../ErrorCode.java`). Mapping to HTTP status happens either in each controller's `catch (IllegalArgumentException)` matching on the message, or in the service's `GlobalExceptionHandler`. Match on exact string, not an enum.
- **DTOs as records**: request/response DTOs are Java 17 records nested in a domain container class (`AuthDto.UserResponse`, `TaskDto.TaskResponse`). Use `@Valid` + Jakarta Bean Validation annotations on request records, and `@RequestHeader("X-User-Id") UUID userId` in controllers.
- **No Lombok**: entities use hand-written getters/setters; plain constructors.
- **Auth**: `DevModeAuthFilter` authenticates from the `X-User-Id` header (dev bypass). Internal cross-service endpoints are `permitAll` in each `SecurityConfig` — currently project `/api/v1/projects/check-permission` and task `/api/v1/projects/*/tasks/active-count`; register any new internal endpoint there too. All endpoints are under `/api/v1`.
- **Reads return null**: most service getters return `null` for missing entities and the controller answers 404 (rather than throwing).

## Testing norms
- Add a Mock-service unit test for new behavior (see `user-service/.../MockAuthServiceTest`, `project-service/.../MockProjectServiceTest`). `task-service` currently has no tests — add one when touching it there. Mock inter-service `client/` collaborators, never real HTTP.