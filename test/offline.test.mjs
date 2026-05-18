// Must be imported before Dexie so it patches globalThis.indexedDB first
import 'fake-indexeddb/auto'

process.on('unhandledRejection', (reason, promise) => {
   console.error('UNHANDLED REJECTION:', reason)
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { io as ioc } from 'socket.io-client'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core'
import { eq } from 'drizzle-orm'

import { expressX, computeSyncResult } from '@jcbuisson/express-x'
import { createClient, offlinePlugin } from '@jcbuisson/express-x-client'

import { drizzleOfflinePlugin } from '@jcbuisson/express-x-drizzle'

const T0 = new Date('2026-01-01T00:00:00Z')
const T1 = new Date('2026-01-02T00:00:00Z')
const T2 = new Date('2026-01-03T00:00:00Z')

let dbCounter = 0

// ─── In-memory DB helper ──────────────────────────────────────────────────────
// Each test gets a fresh PGlite instance with a unique model table so tests
// are fully isolated. Model names use underscores (PG-safe identifiers).

async function createTestDb(modelName) {
   const pglite = new PGlite()
   await pglite.exec(`
      CREATE TABLE metadata (
         uid TEXT PRIMARY KEY,
         created_at TIMESTAMP,
         updated_at TIMESTAMP,
         deleted_at TIMESTAMP
      );
      CREATE TABLE "${modelName}" (
         uid TEXT PRIMARY KEY,
         label TEXT NOT NULL
      );
   `)
   const db = drizzle(pglite)
   const metaTable = pgTable('metadata', {
      uid: text('uid').primaryKey(),
      created_at: timestamp(),
      updated_at: timestamp(),
      deleted_at: timestamp(),
   })
   const modelTable = pgTable(modelName, {
      uid: text('uid').primaryKey(),
      label: text('label').notNull(),
   })
   return { db, metaTable, modelTable }
}

// ─── Test context helper ──────────────────────────────────────────────────────

async function createTestContext(registerServices, { useOfflinePlugin = false } = {}) {
   const serverApp = expressX({})
   registerServices(serverApp)

   await new Promise(resolve => serverApp.httpServer.listen(0, resolve))
   const port = serverApp.httpServer.address().port

   const socket = ioc(`http://localhost:${port}`, {
      transports: ['websocket'],
      autoConnect: false,
   })

   const clientApp = createClient(socket, { debug: false })
   if (useOfflinePlugin) offlinePlugin(clientApp)

   socket.connect()
   await new Promise((resolve, reject) => {
      socket.on('connect', resolve)
      socket.on('connect_error', reject)
   })

   const cleanup = () => new Promise(resolve => {
      socket.disconnect()
      serverApp.io.close(resolve)
   })

   return { clientApp, cleanup }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Full offline-first client ↔ server protocol', () => {

   test('service call is routed through client-request / client-response', async () => {
      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService('greet', {
            hello: async (name) => `Hello, ${name}!`,
         })
      })

      try {
         const result = await clientApp.service('greet').hello('World')
         assert.equal(result, 'Hello, World!')
      } finally {
         await cleanup()
      }
   })

   test('server error is propagated to the client as a rejection', async () => {
      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService('broken', {
            explode: async () => { throw new Error('something went wrong') },
         })
      })

      try {
         await assert.rejects(
            () => clientApp.service('broken').explode(),
            err => {
               assert.match(err.message, /something went wrong/)
               return true
            },
         )
      } finally {
         await cleanup()
      }
   })
   


})
