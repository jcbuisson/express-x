# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**express-x** is a full-stack framework that unifies backend and frontend communication through WebSocket-based services.
It's published as `@jcbuisson/express-x` on npm.

Core concept: ExpressX is a thin wrapper around Express.js and Socket.io that provides a service-oriented, real-time RPC pattern.
Clients call server-side service methods via WebSocket and receive results as promises.
Services can publish events to channels, enabling pub/sub-style real-time updates.

**Repository**: https://github.com/jcbuisson/express-x  
**Documentation**: https://expressx.jcbuisson.dev  
**Version**: 3.0.3 (ES modules)

## Development Commands

```bash
# Install dependencies
npm install

# Run integration tests (round-trip + offline sync via real sockets/PGlite/Dexie)
npm test

# Run unit tests for the sync algorithm only
node --import tsx/esm --test test/sync.test.mjs

# Run both test files
node --import tsx/esm --test --test-force-exit test/round-trip.test.mjs test/sync.test.mjs

# Run a single named test (partial match on test name)
node --import tsx/esm --test --test-force-exit --test-name-pattern="service call" test/round-trip.test.mjs
```

No build step — the source is run directly as ES modules.

## Architecture

### Single Source File
- `src/server.mjs` is the complete server-side framework. All exports live here.

### Related Packages (also authored here, published separately)
- **`@jcbuisson/express-x-client`** (`node_modules/@jcbuisson/express-x-client/src/client.mts`) — client-side library: `createClient`, `offlinePlugin`, `Mutex`, `wherePredicate`. TypeScript source consumed directly via `tsx`.
- **`@jcbuisson/express-x-drizzle`** (`node_modules/@jcbuisson/express-x-drizzle/src/drizzle-plugins.mjs`) — Drizzle ORM variant of the offline plugin. The installed version may lag behind local development; the authoritative Drizzle plugin logic for tests is wired via `serverApp.configure(drizzleOfflinePlugin, ...)`.

### Core Concepts

1. **Services**: Named groups of callable methods. Created via `app.createService(name, methods)`. Each method is wrapped to support hooks and pub/sub.

2. **Context Object**: Passed to every hooked method — contains `app`, `socket`, `serviceName`, `methodName`, `args`, `result`, `caller` ('client'|'server'), `transport` ('ws').

3. **Hooks**: Pre/post-execution filters attached via `service.hooks({ before: { methodName: [...], all: [...] }, after: {...} })`. Hooks run: `before.all` → `before.method` → method → `after.method` → `after.all`.

4. **Channels & Pub/Sub**: Socket.io rooms. After a service method completes, `service.publishFunction(context)` returns channel names; the result is broadcast as `service-event` to all sockets in those rooms. Clients subscribe with `app.service(name).on(action, handler)`.

5. **WebSocket Protocol**: Client emits `client-request {uid, name, action, args}` → server emits `client-response {uid, result|error}`. Requests are correlated by `uid`.

### Offline Sync Architecture

The sync system reconciles a client Dexie cache with a server database. The protocol:

1. Client calls `sync.go(modelName, where, cutoffDate, clientMetadataDict)` with its local metadata snapshot.
2. Server computes diff using `computeSyncResult` (exported from `server.mjs`, pure function, no I/O).
3. Server returns `{ addClient, updateClient, deleteClient, addDatabase, updateDatabase }`.
4. Client applies each batch: puts addClient records into Dexie, deletes deleteClient, updates updateClient, then calls `createWithMeta`/`updateWithMeta` for addDatabase/updateDatabase.

**Two offline plugin implementations:**
- `offlinePlugin` in `server.mjs` — Prisma-based (legacy, uses `prisma.$transaction`).
- `drizzleOfflinePlugin` from `@jcbuisson/express-x-drizzle` — Drizzle ORM-based, used in all tests.

**`computeSyncResult(databaseValuesDict, clientMetadataDict, databaseMetadataDict)`** is the pure sync algorithm exported from `server.mjs`. It uses `null` (not `new Date()`) as the fallback `created_at` for missing metadata, so a record without metadata is treated as older than any client record, preventing infinite `updateClient` loops.

### Key Plugins
- **reloadPlugin**: Caches socket data/rooms on disconnect; restores them on reconnect via `cnx-transfer` socket event.
- **offlinePlugin (Prisma)**: CRUD services + `sync.go` for offline-first with Prisma.
- **drizzleOfflinePlugin**: Same pattern using Drizzle ORM + PGlite-compatible transactions.

### Exported Utilities
- `Mutex` — simple async mutex used by sync and offline plugins.
- `truncateString` — log truncation helper.
- `addTimestamp(field)`, `hashPassword(field)`, `protect(field)` — common hook factories.
- `EXError(code, message)` — custom error class; `code` is serialized and sent to the client.
- `computeSyncResult` — pure sync diff algorithm.

## Test Structure

- `test/round-trip.test.mjs` — Integration tests. Spins up a real Express/Socket.io server on a random port, connects via `socket.io-client`, uses PGlite (in-memory Postgres) + Drizzle + Dexie (via `fake-indexeddb`). Tests cover the full client↔server sync protocol, pub/sub, rollbacks, and edge cases. Each test gets an isolated PGlite instance and unique model name.
- `test/sync.test.mjs` — Unit tests for `computeSyncResult` only. Imports from `#root/src/drizzle-plugins.mjs` (the `#root/*` alias maps to the repo root via `package.json` imports).

## Configuration

`expressX(config)` accepts:
- `config.WS_PATH` (default: `'/socket.io/'`): Socket.io path
- `config.maxDisconnectionDuration` (default: 2 min): Connection recovery window
- Accessible server-side as `app.get('config')`

## Key Dependencies
- **express** / **socket.io**: HTTP + WebSocket server
- **bcryptjs**: Password hashing (hook utility)
- Dev: **@electric-sql/pglite** (in-memory Postgres for tests), **drizzle-orm**, **fake-indexeddb** (Dexie in Node), **tsx** (runs `.mts` client source directly), **dexie**, **rxjs**, **uuid**, **@vueuse/core**
