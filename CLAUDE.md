# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**express-x** is a full-stack framework that unifies backend and frontend communication through WebSocket-based services. It's published as `@jcbuisson/express-x` on npm.

Core concept: ExpressX is a thin wrapper around Express.js and Socket.io that provides a service-oriented, real-time RPC pattern. Clients call server-side service methods via WebSocket and receive results as promises. Services can publish events to channels, enabling pub/sub-style real-time updates.

**Repository**: https://github.com/jcbuisson/express-x  
**Documentation**: https://expressx.jcbuisson.dev  
**Version**: 3.0.3 (ES modules)

## Architecture

### Single Entry Point
- `/src/server.mjs` (625 lines) is the complete framework implementation. This is the only source file.
- Exports the main `expressX()` factory function and various utilities/plugins.

### Core Concepts

1. **Services**: Named groups of callable methods. Created via `app.createService(name, methods)`. Each method receives a `context` object containing metadata about the call (transport, socket, service/method names, args).

2. **Context Object**: Contains execution metadata:
   - `app`, `socket`, `serviceName`, `methodName`, `args`, `result`
   - `caller` ('client' or 'server'), `transport` ('ws')
   - Modified by hooks before/after method execution

3. **Hooks**: Pre/post-execution functions that can modify context or validate requests. Attached to services via `service.hooks()`. Support method-specific and "all methods" variants:
   ```js
   service.hooks({
     before: { methodName: [hook1, hook2], all: [globalHook] },
     after: { methodName: [hook], all: [globalHook] }
   })
   ```

4. **Channels & Pub/Sub**: Enable real-time broadcasting:
   - Channels are Socket.io rooms with names
   - Services attach a `publishFunction` via `service.publish()` that determines which channels receive events after method execution
   - Clients join/subscribe to channels via `app.joinChannel(name, socket)`
   - Events are published as `service-event` messages containing `{name, action, result}`

5. **WebSocket Protocol**: Single `client-request` event from client → `client-response` event from server, with uid-based request/response correlation. Errors are serialized and sent back to client.

### Key Plugins

- **reloadPlugin**: Manages connection recovery across page reloads/reconnects by caching socket data and rooms.
- **offlinePlugin**: Implements offline-first CRUD operations with Prisma. Provides `sync.go()` service method that reconciles client cache with database using timestamps (created_at, updated_at, deleted_at).

### Common Hook Patterns (Exported Utilities)
- `addTimestamp(field)`: Adds ISO timestamp to result
- `hashPassword(field)`: Hashes password using bcryptjs
- `protect(field)`: Removes sensitive fields from results

### Error Handling
- `EXError(code, message)`: Custom error class with error codes. Method errors are caught, serialized, and sent to client as rejected promises.

## Development Commands

```bash
# Install dependencies
npm install

# Prisma (optional, if using database)
npm run generate    # Generate Prisma client
npm run migrate     # Run Prisma migrations

# No dedicated test, build, or lint scripts
# Manual testing via client-server examples in README
```

## Key Dependencies
- **express** (^4.18.2): HTTP server framework
- **socket.io** (^4.6.0): WebSocket server
- **bcryptjs** (^2.4.3): Password hashing
- **config** (^3.3.9): Configuration management
- Peer: Prisma for database CRUD services (optional)

## File Structure
```
express-x/
  src/server.mjs          # Complete framework (625 lines)
  package.json            # v3.0.3, ES module type
  README.md               # Getting started + examples
  .vscode/launch.json     # Debug config
```

## Implementation Notes

1. **Context Execution**: Service methods are wrapped with hook execution:
   - All `before.all` hooks → method-specific `before` hooks → method execution → method-specific `after` hooks → all `after.all` hooks
   - Hooks receive context and can throw errors (which propagate to client)

2. **Event Publishing**: After a service method completes, `publishFunction` is called with the context. It returns an array of channel names. The result is broadcast to all sockets in those channels as a `service-event`.

3. **Connection State**: Socket.io's built-in `socket.data` object stores per-connection state. Socket.io's connection recovery feature (2-minute default) restores socket.id, rooms, and data on network reconnects.

4. **Offline Sync**: The `offlinePlugin` uses transaction-safe Prisma operations and a mutex to ensure consistent synchronization. Clients track operation timestamps and the sync algorithm compares created_at/updated_at to determine add/update/delete operations.

5. **Logging**: App-level logging via `app.log(severity, message)`. If no logger is configured, falls back to console.log.

## Configuration

ExpressX accepts an optional config object (first parameter to `expressX(config)`):
- `config.WS_PATH` (default: '/socket.io/'): Socket.io path
- `config.maxDisconnectionDuration` (default: 2 min): Connection recovery window
- Any config is accessible server-side via `app.get('config')`

