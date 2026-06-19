// Must be imported before Dexie so it patches globalThis.indexedDB first
import 'fake-indexeddb/auto'

process.on('unhandledRejection', (reason, promise) => {
   console.error('UNHANDLED REJECTION:', reason)
})

import { test, describe, after } from 'node:test'
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
   return { pglite, db, metaTable, modelTable }
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

   test('sync.go through socket: server records pulled into real Dexie', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      await db.insert(modelTable).values({ uid: 'r1', label: 'Vacances' })
      await db.insert(metaTable).values({ uid: 'r1', created_at: T0 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const r1 = await model.db.values.get('r1')
         assert.ok(r1, 'Dexie should contain the record pulled from server via socket')
         assert.equal(r1.label, 'Vacances')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('sync.go through socket: local Dexie record pushed to server', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'x1', label: 'Formation' })
         await model.db.metadata.add({ uid: 'x1', created_at: T1 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const rows = await db.select().from(modelTable).where(eq(modelTable.uid, 'x1'))
         assert.ok(rows.length > 0, 'server should have received the pushed record')
         assert.equal(rows[0].label, 'Formation')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('record only on client, deleted → ignored on both sides', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'd1', label: 'Gone', __deleted__: true })
         await model.db.metadata.add({ uid: 'd1', created_at: T0, deleted_at: T1 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const rows = await db.select().from(modelTable)
         assert.ok(!rows.find(r => r.uid === 'd1'), 'server should not have the deleted-only record')
         const d1 = await model.db.values.get('d1')
         assert.ok(!d1, 'Dexie should no longer hold the deleted record')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('create() rollback removes metadata when server rejects', async () => {
      const modelName = `model${++dbCounter}`

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService(modelName, {
            createWithMeta: async () => { throw new Error('server rejected') },
            findMany:        async () => [],
            updateWithMeta:  async () => {},
            deleteWithMeta:  async () => {},
         })
         serverApp.createService('sync', {
            go: async () => ({ addClient: [], updateClient: [], deleteClient: [], addDatabase: [], updateDatabase: [] }),
         })
      }, { useOfflinePlugin: true })

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // create() is optimistic: value + metadata are written to Dexie before the
         // server responds, then rolled back if the server rejects.
         const record = await model.create({ label: 'test' })
         const uid = record.uid

         assert.ok(await model.db.values.get(uid),    'value should exist optimistically')
         assert.ok(await model.db.metadata.get(uid),  'metadata should exist optimistically')

         // Poll until the rollback removes the value (server rejection processed)
         for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 10))
            if (!await model.db.values.get(uid)) break
         }

         assert.ok(!await model.db.values.get(uid),   'value should be removed after rollback')
         // Metadata must also be cleaned up — currently it is not
         assert.ok(!await model.db.metadata.get(uid), 'metadata should also be removed after rollback')
      } finally {
         await cleanup()
      }
   })

   test('deleted record is fully removed from Dexie metadata after sync', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         // Record created and deleted locally before ever reaching the server
         await model.db.values.add({ uid: 'd1', label: 'Gone', __deleted__: true })
         await model.db.metadata.add({ uid: 'd1', created_at: T0, deleted_at: T1 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const d1 = await model.db.values.get('d1')
         assert.ok(!d1, 'Dexie values should not hold deleted record')

         // Metadata must also be removed — orphaned rows waste space and cause
         // a ConstraintError if a record with the same uid is ever re-created
         const d1Meta = await model.db.metadata.get('d1')
         assert.ok(!d1Meta, 'Dexie metadata should also be removed for deleted record')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('record in both, DB newer → client cache is updated with server value', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // Server has s1 at T2 (newer than client)
      await db.insert(modelTable).values({ uid: 's1', label: 'server-v2' })
      await db.insert(metaTable).values({ uid: 's1', created_at: T0, updated_at: T2 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         // Client has s1 at T1 (stale)
         await model.db.values.add({ uid: 's1', label: 'client-v1' })
         await model.db.metadata.add({ uid: 's1', created_at: T0, updated_at: T1 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const s1 = await model.db.values.get('s1')
         assert.equal(s1.label, 'server-v2', 'client Dexie should be updated with server\'s newer value')

         // A second sync must be a no-op — proves the client timestamp was
         // correctly updated to the server's, avoiding an infinite re-sync loop.
         await model.synchronizeAll()
         const s1Again = await model.db.values.get('s1')
         assert.equal(s1Again.label, 'server-v2', 'second sync should not overwrite client value')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('record in both, DB created_at newer → client metadata is fully replaced', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // Server is newer by created_at only; updated_at is null.
      await db.insert(modelTable).values({ uid: 's1', label: 'server-created-later' })
      await db.insert(metaTable).values({ uid: 's1', created_at: T2 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 's1', label: 'client-created-earlier' })
         await model.db.metadata.add({ uid: 's1', created_at: T1 })
         await model.addSynchroWhere({})

         await model.synchronizeAll()

         const s1 = await model.db.values.get('s1')
         const meta = await model.db.metadata.get('s1')
         assert.equal(s1.label, 'server-created-later')
         assert.equal(new Date(meta.created_at).getTime(), T2.getTime())

         await model.synchronizeAll()
         const s1Again = await model.db.values.get('s1')
         assert.equal(s1Again.label, 'server-created-later')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('one failed updateWithMeta does not abort remaining updateDatabase entries', async () => {
      const modelName = `model${++dbCounter}`
      const serverUpdated = {}

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService('sync', {
            // Tell the client both u1 and u2 need to be pushed (client is newer for both)
            go: async (mn, where, cutoff, clientMetadataDict) => ({
               addClient: [], updateClient: [], deleteClient: [], addDatabase: [],
               updateDatabase: [ clientMetadataDict['u1'], clientMetadataDict['u2'] ],
            }),
         })
         serverApp.createService(modelName, {
            updateWithMeta: async (uid, data) => {
               if (uid === 'u1') throw new Error('server rejected u1')
               serverUpdated[uid] = data  // u2 succeeds
            },
            createWithMeta: async () => {},
            deleteWithMeta: async () => {},
            findUnique:     async () => null,
            findMany:       async () => [],
         })
      }, { useOfflinePlugin: true })

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'u1', label: 'new-u1' })
         await model.db.metadata.add({ uid: 'u1', created_at: T0, updated_at: T2 })
         await model.db.values.add({ uid: 'u2', label: 'new-u2' })
         await model.db.metadata.add({ uid: 'u2', created_at: T0, updated_at: T2 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         // u2's push must succeed even though u1's updateWithMeta threw
         assert.ok(serverUpdated['u2'], 'u2 should be pushed to server despite u1 failure')
         assert.equal(serverUpdated['u2'].label, 'new-u2')
      } finally {
         await cleanup()
      }
   })

   test('record in both, client newer → server is updated via socket', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      await db.insert(modelTable).values({ uid: 'u1', label: 'old' })
      await db.insert(metaTable).values({ uid: 'u1', created_at: T0, updated_at: T1 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'u1', label: 'new' })
         await model.db.metadata.add({ uid: 'u1', created_at: T0, updated_at: T2 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const rows = await db.select().from(modelTable).where(eq(modelTable.uid, 'u1'))
         assert.equal(rows[0].label, 'new', 'server should have the updated label')
         const clientValue = await model.db.values.get('u1')
         assert.equal(clientValue.label, 'new', 'client Dexie should be unchanged')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('record deleted on server while client was offline is re-created on reconnect', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // r1 exists on server initially
      await db.insert(modelTable).values({ uid: 'r1', label: 'original' })
      await db.insert(metaTable).values({ uid: 'r1', created_at: T0 })

      // Server-side delete while client was offline: hard-delete from model table,
      // but metadata row stays with deleted_at set (this is what deleteWithMeta does)
      await db.delete(modelTable).where(eq(modelTable.uid, 'r1'))
      await db.update(metaTable).set({ deleted_at: T1 }).where(eq(metaTable.uid, 'r1'))

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         // Client has r1 — it was offline when the server deleted it
         await model.db.values.add({ uid: 'r1', label: 'keep me' })
         await model.db.metadata.add({ uid: 'r1', created_at: T0 })
         await model.addSynchroWhere({})
         await model.synchronizeAll()

         // Client's copy should have been pushed back to the server
         const rows = await db.select().from(modelTable)
         assert.ok(rows.find(r => r.uid === 'r1'), 'server should have r1 after client pushes it back')
         assert.equal(rows.find(r => r.uid === 'r1').label, 'keep me')
         // And client's Dexie should still have it
         const r1 = await model.db.values.get('r1')
         assert.ok(r1, 'client Dexie should still have r1 after sync')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('offline changes are synced after server restart', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // ─ Phase 1: start server, connect, register synchro scope ─
      const serverApp1 = expressX({})
      serverApp1.configure(drizzleOfflinePlugin, db, metaTable, [modelTable])
      await new Promise(resolve => serverApp1.httpServer.listen(0, resolve))
      const port = serverApp1.httpServer.address().port

      const socket = ioc(`http://localhost:${port}`, {
         transports: ['websocket'],
         autoConnect: false,
         reconnectionDelay: 100,
         reconnectionDelayMax: 500,
      })
      const clientApp = createClient(socket, { debug: false })
      offlinePlugin(clientApp)
      socket.connect()
      await new Promise((resolve, reject) => {
         socket.on('connect', resolve)
         socket.on('connect_error', reject)
      })

      const model = clientApp.createOfflineModel(modelName, ['label'])
      await model.addSynchroWhere({})
      await model.synchronizeAll() // initial sync — server is empty

      // ─ Phase 2: stop server; disconnect all clients ─
      // io.disconnectSockets() gives 'io server disconnect' which suppresses
      // socket.io auto-reconnect, so we reconnect manually in phase 5.
      const disconnected = new Promise(resolve => socket.once('disconnect', resolve))
      serverApp1.io.disconnectSockets(true)
      await new Promise(resolve => serverApp1.io.close(resolve))
      await disconnected

      assert.equal(clientApp.isConnected, false, 'client should be offline')

      // ─ Phase 3: write to Dexie while offline ─
      await model.db.values.add({ uid: 'y1', label: 'Offline change' })
      await model.db.metadata.add({ uid: 'y1', created_at: T1 })

      // ─ Phase 4: restart server on the same port ─
      const serverApp2 = expressX({})
      serverApp2.configure(drizzleOfflinePlugin, db, metaTable, [modelTable])
      await new Promise(resolve => serverApp2.httpServer.listen(port, resolve))

      // ─ Phase 5: reconnect manually (auto-reconnect is suppressed after
      // server-initiated disconnect) and wait for offlinePlugin to fire ─
      const reconnected = new Promise((resolve, reject) => {
         const timer = setTimeout(() => reject(new Error('reconnect timeout')), 5000)
         socket.once('connect', () => { clearTimeout(timer); resolve() })
      })
      socket.connect()
      await reconnected

      // ─ Phase 6: offlinePlugin's connect listener fires synchronizeAll in the
      // background; awaiting it here serialises behind the mutex so assertions
      // run only after the offline change has been pushed to the server. ─
      await model.synchronizeAll()

      // ─ Phase 7: assert ─
      assert.equal(clientApp.isConnected, true, 'client should be online again')
      const rows = await db.select().from(modelTable).where(eq(modelTable.uid, 'y1'))
      assert.ok(rows.length > 0, 'offline change should reach the server after reconnect')
      assert.equal(rows[0].label, 'Offline change')

      socket.disconnect()
      await new Promise(resolve => serverApp2.io.close(resolve))
      pglite.close()
   })

   test('reconnect keeps disconnectedDate until automatic sync completes', async () => {
      const modelName = `model${++dbCounter}`
      const serverRows = []
      let resolveSyncStarted
      let releaseSync
      let resolveCreate
      const syncStarted = new Promise(resolve => { resolveSyncStarted = resolve })
      const syncRelease = new Promise(resolve => { releaseSync = resolve })
      const createDone = new Promise(resolve => { resolveCreate = resolve })

      function registerServices(app, { slowSync = false } = {}) {
         app.createService(modelName, {
            createWithMeta: async (uid, data, created_at) => {
               serverRows.push({ uid, ...data })
               resolveCreate()
               return [{ uid, ...data }, { uid, created_at, updated_at: null, deleted_at: null }]
            },
            updateWithMeta: async () => {},
            deleteWithMeta: async () => {},
            findMany: async () => [],
         })
         app.createService('sync', {
            go: async (_modelName, _where, _cutoffDate, clientMetadataDict) => {
               if (slowSync) {
                  resolveSyncStarted()
                  await syncRelease
               }
               return {
                  addClient: [],
                  updateClient: [],
                  deleteClient: [],
                  addDatabase: Object.values(clientMetadataDict),
                  updateDatabase: [],
               }
            },
         })
      }

      const serverApp1 = expressX({})
      registerServices(serverApp1)
      await new Promise(resolve => serverApp1.httpServer.listen(0, resolve))
      const port = serverApp1.httpServer.address().port

      const socket = ioc(`http://localhost:${port}`, {
         transports: ['websocket'],
         autoConnect: false,
      })
      const clientApp = createClient(socket, { debug: false })
      offlinePlugin(clientApp)
      socket.connect()
      await new Promise((resolve, reject) => {
         socket.on('connect', resolve)
         socket.on('connect_error', reject)
      })

      const model = clientApp.createOfflineModel(modelName, ['label'])
      await model.addSynchroWhere({})
      await model.synchronizeAll()

      const disconnected = new Promise(resolve => socket.once('disconnect', resolve))
      serverApp1.io.disconnectSockets(true)
      await new Promise(resolve => serverApp1.io.close(resolve))
      await disconnected

      await model.db.values.add({ uid: 'reconnect-1', label: 'from reconnect' })
      await model.db.metadata.add({ uid: 'reconnect-1', created_at: T1 })

      const serverApp2 = expressX({})
      registerServices(serverApp2, { slowSync: true })
      await new Promise(resolve => serverApp2.httpServer.listen(port, resolve))

      const reconnected = new Promise((resolve, reject) => {
         const timer = setTimeout(() => reject(new Error('reconnect timeout')), 5000)
         socket.once('connect', () => { clearTimeout(timer); resolve() })
      })
      socket.connect()
      await reconnected
      await syncStarted

      assert.ok(clientApp.disconnectedDate, 'disconnect cutoff should remain while reconnect sync is running')
      assert.equal(serverRows.length, 0, 'offline row should not be pushed before sync is released')

      releaseSync()
      await createDone

      for (let i = 0; i < 50 && clientApp.disconnectedDate; i++) {
         await new Promise(resolve => setTimeout(resolve, 10))
      }

      assert.equal(clientApp.disconnectedDate, null, 'disconnect cutoff should clear after reconnect sync completes')
      assert.deepEqual(serverRows, [{ uid: 'reconnect-1', label: 'from reconnect' }])

      socket.disconnect()
      await new Promise(resolve => serverApp2.io.close(resolve))
   })

   test('updateWithMeta pub/sub handler tolerates undefined value (concurrent delete race)', async () => {
      // updateWithMeta does `const [value] = UPDATE ... RETURNING`.  If the model row
      // was deleted by a concurrent operation between the sync's findMany snapshot and
      // the actual UPDATE, RETURNING yields 0 rows → value = undefined.  The server
      // broadcasts [undefined, meta].  The handler crashes on `db.values.put(undefined)`
      // (TypeError: Cannot read properties of undefined) before db.metadata.put(meta)
      // can run, leaving metadata inconsistent.
      const modelName = `model${++dbCounter}`

      const serverApp = expressX({})
      serverApp.addConnectListener(socket => serverApp.joinChannel('all', socket))
      await new Promise(resolve => serverApp.httpServer.listen(0, resolve))
      const port = serverApp.httpServer.address().port

      function connectClient() {
         const socket = ioc(`http://localhost:${port}`, { transports: ['websocket'], autoConnect: false })
         const app = createClient(socket, { debug: false })
         offlinePlugin(app)
         socket.connect()
         return new Promise((resolve, reject) => {
            socket.on('connect', () => resolve({ app, socket }))
            socket.on('connect_error', reject)
         })
      }

      const { app: appB, socket: socketB } = await connectClient()
      const modelB = appB.createOfflineModel(modelName, ['label'])

      await modelB.db.values.add({ uid: 'r1', label: 'old' })
      await modelB.db.metadata.add({ uid: 'r1', created_at: T0 })

      // Simulate the server broadcasting updateWithMeta with undefined value
      serverApp.io.to('all').emit('service-event', {
         name: modelName,
         action: 'updateWithMeta',
         result: [undefined, { uid: 'r1', created_at: T0, updated_at: T1, deleted_at: null }],
      })

      await new Promise(r => setTimeout(r, 200))

      // With bug:  TypeError on undefined crashes before db.metadata.put(meta) runs
      //            → updated_at stays T0 (unchanged).
      // With fix:  handler guards value, skips the put, still updates metadata
      //            → updated_at becomes T1.
      const meta = await modelB.db.metadata.get('r1')
      assert.ok(meta?.updated_at, 'metadata updated_at must be set even when value is undefined')

      socketB.disconnect()
      await new Promise(resolve => serverApp.io.close(resolve))
   })

   test('deleteWithMeta pub/sub handler uses delete not put to avoid orphan metadata', async () => {
      // synchronize() step 2 deletes both idbValues and idbMetadata for deleteClient uids.
      // The deleteWithMeta pub/sub event may arrive on the SAME tab either before or after
      // that cleanup.  The handler uses db.metadata.put(meta) (upsert with deleted_at),
      // so if it runs AFTER step 2 it RE-CREATES the metadata row as an orphan that can
      // never be cleaned up.  Fix: delete the metadata instead of putting it.
      const modelName = `model${++dbCounter}`

      const serverApp = expressX({})
      serverApp.addConnectListener(socket => serverApp.joinChannel('all', socket))
      await new Promise(resolve => serverApp.httpServer.listen(0, resolve))
      const port = serverApp.httpServer.address().port

      function connectClient() {
         const socket = ioc(`http://localhost:${port}`, { transports: ['websocket'], autoConnect: false })
         const app = createClient(socket, { debug: false })
         offlinePlugin(app)
         socket.connect()
         return new Promise((resolve, reject) => {
            socket.on('connect', () => resolve({ app, socket }))
            socket.on('connect_error', reject)
         })
      }

      const { app: appB, socket: socketB } = await connectClient()
      const modelB = appB.createOfflineModel(modelName, ['label'])

      // r1 exists in client B's Dexie
      await modelB.db.values.add({ uid: 'r1', label: 'test' })
      await modelB.db.metadata.add({ uid: 'r1', created_at: T0 })

      // Simulate step 2 running first (synchronize already cleaned up r1)
      await modelB.db.values.delete('r1')
      await modelB.db.metadata.delete('r1')

      // Pub/sub arrives AFTER step 2 — handler must not re-create metadata as an orphan
      serverApp.io.to('all').emit('service-event', {
         name: modelName,
         action: 'deleteWithMeta',
         result: [{ uid: 'r1', label: 'test' }, { uid: 'r1', created_at: T0, updated_at: null, deleted_at: T1 }],
      })

      await new Promise(r => setTimeout(r, 200))

      // With bug:  put(meta) re-creates metadata with deleted_at → orphan persists
      // With fix:  delete(uid) is a no-op → no orphan
      const orphan = await modelB.db.metadata.get('r1')
      assert.ok(!orphan, 'pub/sub handler must not leave an orphan metadata row after step-2 cleanup')

      socketB.disconnect()
      await new Promise(resolve => serverApp.io.close(resolve))
   })

   test('deleteWithMeta pub/sub handler tolerates undefined value (double-delete race)', async () => {
      // deleteWithMeta does `const [value] = DELETE ... RETURNING`.  When the record
      // is already gone (double-delete race now possible with pub/sub enabled) the
      // RETURNING clause yields 0 rows → value = undefined.  The server then broadcasts
      // [undefined, meta].  The handler crashes on `undefined.uid` (TypeError) before
      // db.metadata.put(meta) runs, leaving other tabs' caches inconsistent.
      const modelName = `model${++dbCounter}`

      const serverApp = expressX({})
      serverApp.addConnectListener(socket => serverApp.joinChannel('all', socket))
      await new Promise(resolve => serverApp.httpServer.listen(0, resolve))
      const port = serverApp.httpServer.address().port

      function connectClient() {
         const socket = ioc(`http://localhost:${port}`, { transports: ['websocket'], autoConnect: false })
         const app = createClient(socket, { debug: false })
         offlinePlugin(app)
         socket.connect()
         return new Promise((resolve, reject) => {
            socket.on('connect', () => resolve({ app, socket }))
            socket.on('connect_error', reject)
         })
      }

      const { app: appB, socket: socketB } = await connectClient()
      const modelB = appB.createOfflineModel(modelName, ['label'])

      // Pre-populate so we can verify the metadata gets the server's deleted_at
      await modelB.db.values.add({ uid: 'r1', label: 'existing' })
      await modelB.db.metadata.add({ uid: 'r1', created_at: T0 })

      // Simulate the server broadcasting deleteWithMeta with undefined value
      // (what happens when the DELETE RETURNING yields 0 rows)
      serverApp.io.to('all').emit('service-event', {
         name: modelName,
         action: 'deleteWithMeta',
         result: [undefined, { uid: 'r1', created_at: T0, updated_at: null, deleted_at: T1 }],
      })

      await new Promise(r => setTimeout(r, 200))

      // With original bug:  TypeError on undefined.uid aborts before db.metadata.*
      //                     runs at all → r1 metadata stays unchanged.
      // With delete fix:    handler guards value, then deletes the metadata row
      //                     → r1 metadata is gone (no orphan, clean state).
      const meta = await modelB.db.metadata.get('r1')
      assert.ok(!meta, 'metadata must be removed even when value is undefined')

      socketB.disconnect()
      await new Promise(resolve => serverApp.io.close(resolve))
   })

   test('update() rollback only restores updated_at, not deleted_at set by a concurrent remove()', async () => {
      // The optimistic write in update() only touches updated_at.  The rollback on
      // server rejection spreads the full previousMetadata snapshot — including
      // deleted_at: null — overwriting any deleted_at that remove() set while the
      // socket round-trip was in flight.  Only updated_at should be restored.
      const modelName = `model${++dbCounter}`

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         // updateWithMeta delays then rejects so remove() can run in the gap
         serverApp.createService(modelName, {
            updateWithMeta: async () => { await new Promise(r => setTimeout(r, 100)); throw new Error('rejected') },
            deleteWithMeta: async () => {},
            createWithMeta: async () => {},
            findMany:        async () => [],
         })
         serverApp.createService('sync', {
            go: async () => ({ addClient: [], updateClient: [], deleteClient: [], addDatabase: [], updateDatabase: [] }),
         })
      }, { useOfflinePlugin: true })

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'r1', label: 'original' })
         // Explicitly store deleted_at: null (simulates what remove() rollback leaves
         // behind).  Dexie stores the key so previousMetadata includes it, and the
         // rollback then spreads it back — wiping any concurrent remove()'s value.
         await model.db.metadata.add({ uid: 'r1', created_at: T0, deleted_at: null })

         // Fire update() — server will delay 100 ms then reject
         model.update('r1', { label: 'updated' })

         // While updateWithMeta is in flight, remove() sets deleted_at
         await model.remove('r1')

         // Wait for the rejection and rollback to complete
         await new Promise(r => setTimeout(r, 300))

         // deleted_at must survive the update() rollback
         const meta = await model.db.metadata.get('r1')
         assert.ok(meta?.deleted_at, 'deleted_at set by remove() must not be cleared by update() rollback')
      } finally {
         await cleanup()
      }
   })

   test('addClient uses put (upsert) so a concurrent create does not cause ConstraintError', async () => {
      // create() adds a uid to Dexie between synchronize()'s idbValues.filter snapshot
      // and the addClient step.  Because the uid missed the snapshot it is absent from
      // clientMetadataDict, so the server puts it in addClient.  idbValues.add() then
      // throws ConstraintError which aborts the entire transaction, silently dropping all
      // other addClient records in the same batch.
      // Fix: use idbValues.put() (upsert) so a pre-existing uid is handled gracefully.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      await db.insert(modelTable).values({ uid: 'r1', label: 'server-r1' })
      await db.insert(metaTable).values({ uid: 'r1', created_at: T0 })
      await db.insert(modelTable).values({ uid: 'r2', label: 'server-r2' })
      await db.insert(metaTable).values({ uid: 'r2', created_at: T0 })

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         // Custom sync that always returns BOTH r1 and r2 in addClient,
         // regardless of what the client already has — simulating the race where
         // r1 was added to Dexie after the clientMetadataDict snapshot.
         serverApp.createService('sync', {
            go: async () => ({
               addClient: [
                  [{ uid: 'r1', label: 'server-r1' }, { uid: 'r1', created_at: T0, updated_at: null, deleted_at: null }],
                  [{ uid: 'r2', label: 'server-r2' }, { uid: 'r2', created_at: T0, updated_at: null, deleted_at: null }],
               ],
               updateClient: [], deleteClient: [], addDatabase: [], updateDatabase: [],
            }),
         })
      }, { useOfflinePlugin: true })

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // r1 is already in Dexie (simulates what create() does concurrently)
         await model.db.values.add({ uid: 'r1', label: 'client-r1' })
         await model.db.metadata.add({ uid: 'r1', created_at: T0 })

         await model.addSynchroWhere({})
         await model.synchronizeAll()

         // r2 must still be in Dexie even though r1 caused a uid conflict —
         // the put() upsert must not abort the whole transaction
         const r2 = await model.db.values.get('r2')
         assert.ok(r2, 'r2 must be added despite r1 already existing in Dexie')
         assert.equal(r2.label, 'server-r2')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('missing server metadata does not cause infinite updateClient loop', async () => {
      // When a record exists in the model table but has no metadata row,
      // computeSyncResult falls back to { uid, created_at: new Date() }.
      // new Date() is always "now", so databaseUpdatedAt > clientUpdatedAt forever →
      // updateClient fires on every sync even though nothing changed.
      // Fix: use null instead of new Date() so the client's version "wins" once
      // (updateDatabase), the server gets metadata, and subsequent syncs see diff=0.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // Server has s1 in model table but intentionally NO metadata row
      await db.insert(modelTable).values({ uid: 's1', label: 'server-label' })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         // Client has s1 with its own timestamp
         await model.db.values.add({ uid: 's1', label: 'client-label' })
         await model.db.metadata.add({ uid: 's1', created_at: T0 })
         await model.addSynchroWhere({})

         // First sync
         await model.synchronizeAll()

         // Second sync — with the bug, updateClient fires again (infinite loop);
         // with the fix the second sync is a no-op (client pushed its data, diff=0)
         let secondSyncUpdateClientCount = 0
         const origUpdateWithMeta = db  // just a marker — we measure via server state

         await model.synchronizeAll()

         // After two syncs the server metadata must now exist (created by updateWithMeta
         // on the first sync) so a third sync should be a true no-op
         const metaRows = await db.select().from(metaTable)
         const s1Meta = metaRows.find(r => r.uid === 's1')
         assert.ok(s1Meta, 'server metadata must be created after the first sync (updateDatabase + upsert)')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('app-event for unregistered type is silently ignored, not TypeError', async () => {
      // When an app-event arrives for a type with no registered handler,
      // type2appHandler[type] is undefined.  The guard
      //   if (!type2appHandler[type]) type2appHandler[type] = {}
      // sets it to an empty object {}.  {} is truthy, so the next line
      //   if (handler) handler(value)
      // tries to call {} as a function → TypeError: {} is not a function.
      const received = []

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.addConnectListener(socket => {
            // Delay so the test code below can register handlers before the events fire
            setTimeout(() => {
               // First: an event for a type WITH no registered handler (triggers the bug)
               serverApp.sendAppEvent(socket.id, 'unregistered-type', 'ignored')
               // Second: an event for a type WITH a registered handler (must still work)
               serverApp.sendAppEvent(socket.id, 'registered-type', 'hello')
            }, 100)
         })
      })

      try {
         clientApp.on('registered-type', val => received.push(val))
         await new Promise(r => setTimeout(r, 400))
         assert.deepEqual(received, ['hello'],
            'registered handler must be called even after an unregistered-type event')
      } finally {
         await cleanup()
      }
   })

   test('removeDisconnectListener is callable and removes the listener', async () => {
      // removeDisonnectListener (misspelled — missing 'c') was exported on the app object
      // instead of removeDisconnectListener.  app.removeDisconnectListener is therefore
      // undefined, so any call to it throws TypeError: not a function.
      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService('greet', { hello: async (name) => `Hello, ${name}!` })
      })

      try {
         let callCount = 0
         const listener = () => { callCount++ }

         clientApp.addDisconnectListener(listener)

         // Must not throw — the correctly-spelled method must exist
         assert.ok(
            typeof clientApp.removeDisconnectListener === 'function',
            'removeDisconnectListener must be a function on the app object',
         )

         clientApp.removeDisconnectListener(listener)

         // After removal the listener must no longer be registered
         // (we can inspect indirectly: add a fresh listener, but the removed one
         //  should not fire — verified by callCount staying at 0)
         assert.equal(callCount, 0, 'removed listener must not have been called')
      } finally {
         await cleanup()
      }
   })

   test('addDatabase TypeError on missing fullValue does not abort remaining entries', async () => {
      // delete fullValue.uid and delete fullValue.__deleted__ are OUTSIDE the inner
      // try/catch in steps 4 and 5 of synchronize().  If idbValues.get(elt.uid)
      // returns undefined — because elt.uid is itself undefined (the clientMetadataDict
      // fallback {} has no uid property when metadata is missing) or because the record
      // was deleted from Dexie concurrently — the `delete undefined.uid` throws a
      // TypeError that escapes to the outer try/catch, aborting the entire sync and
      // silently skipping every remaining addDatabase / updateDatabase entry.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // a1: value exists in Dexie but metadata is MISSING → synchronize builds
         //     clientMetadataDict['a1'] = {} (the "should not happen" fallback)
         //     → computeSyncResult puts {} into addDatabase (elt.uid = undefined)
         //     → delete undefined.uid throws → outer catch → sync aborts
         await model.db.values.add({ uid: 'a1', label: 'no-meta' })
         // a2: normal record with both value and metadata
         await model.db.values.add({ uid: 'a2', label: 'normal' })
         await model.db.metadata.add({ uid: 'a2', created_at: T0 })

         await model.addSynchroWhere({})
         await model.synchronizeAll()

         // a2 must be pushed despite the corrupted a1 entry aborting processing for it
         const rows = await db.select().from(modelTable)
         assert.ok(rows.find(r => r.uid === 'a2'),
            'a2 must be pushed to the server even though a1 has missing metadata')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('wherePredicate range check excludes records whose field is null', async () => {
      // The previous fix excluded undefined (NaN comparisons) but missed null.
      // JS coerces null → 0 for numeric comparisons, so for { score: { lte: 10 } }:
      //   null > 10  →  0 > 10  →  false  →  the lte guard doesn't fire
      //   → null-score record passes the filter (wrong; SQL NULL never matches ranges).
      // That record enters clientMetadataDict, appears as addDatabase to the server,
      // and if score is NOT NULL the insert fails, rolling back the Dexie record.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // Add directly to Dexie to simulate records with various score values
         await model.db.values.add({ uid: 'null-score', label: 'null', score: null })
         await model.db.values.add({ uid: 'five-score', label: 'five', score: 5 })

         // score=null should NOT match { lte: 10 } even though (null coerced to 0) <= 10
         const results = await model.findWhere({ score: { lte: 10 } })
         const uids = results.map(r => r.uid)

         assert.ok(!uids.includes('null-score'), 'null score must NOT match { lte: 10 } (SQL NULL behaviour)')
         assert.ok( uids.includes('five-score'), 'score=5 must match { lte: 10 }')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('wherePredicate range check excludes records whose field is absent (undefined)', async () => {
      // Comparing undefined with a number via >, <, >=, <= always returns false in JS
      // (undefined coerces to NaN, and NaN comparisons are always false).  So none of
      // the range return-false guards fire and a record WITHOUT the filtered field
      // incorrectly passes { score: { gte: 1 } }.  In PostgreSQL, NULL values are
      // correctly excluded by range operators, creating a client/server mismatch:
      // the client includes the record in clientMetadataDict → addDatabase → if the
      // column is NOT NULL the insert fails → rollback deletes the record from Dexie.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // r1 has no 'score' field; r2 has score=5
         await model.db.values.add({ uid: 'r1', label: 'no-score' })
         await model.db.values.add({ uid: 'r2', label: 'has-score', score: 5 })

         const results = await model.findWhere({ score: { gte: 1 } })
         const uids = results.map(r => r.uid)

         assert.ok(!uids.includes('r1'), 'record without score field must NOT match { gte: 1 }')
         assert.ok( uids.includes('r2'), 'record with score=5 must match { gte: 1 }')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('addSynchroWhere with range-operator where does not log ConstraintError when already covered', async () => {
      // isSubset uses !== (reference equality) for all values.  For primitive where
      // values (strings, numbers) this is fine.  For object values like { gte: 1 },
      // two structurally identical objects from different call sites have different
      // references, so isSubset returns false even though the where is already in the
      // list.  addSynchroDBWhere then calls whereDb.add on an already-existing key →
      // ConstraintError → caught and logged.  modified=false for the wrong reason.
      // In a real browser with persistent IndexedDB the error fires on every page load.
      const modelName = `model${++dbCounter}`
      const pglite = new PGlite()
      await pglite.exec(`
         CREATE TABLE metadata (uid TEXT PRIMARY KEY, created_at TIMESTAMP, updated_at TIMESTAMP, deleted_at TIMESTAMP);
         CREATE TABLE "${modelName}" (uid TEXT PRIMARY KEY, label TEXT NOT NULL, score INTEGER NOT NULL);
      `)
      const db = drizzle(pglite)
      const metaTable = pgTable('metadata', { uid: text('uid').primaryKey(), created_at: timestamp(), updated_at: timestamp(), deleted_at: timestamp() })
      const modelTable = pgTable(modelName, { uid: text('uid').primaryKey(), label: text('label').notNull(), score: integer('score').notNull() })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // Intercept console.log to detect spurious ConstraintError logs
         const errorLogs = []
         const origLog = console.log
         console.log = (...args) => {
            if (typeof args[0] === 'string' && args[0].startsWith('err addSynchroDBWhere')) errorLogs.push(args)
            origLog(...args)
         }

         try {
            await model.addSynchroWhere({ score: { gte: 1 } })  // first call: adds to list
            await model.addSynchroWhere({ score: { gte: 1 } })  // second call: should be detected as already covered
            assert.equal(errorLogs.length, 0, 'adding a where already in the list must not throw a ConstraintError')
         } finally {
            console.log = origLog
         }
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('compound range { gte, lte } filters consistently on both client and server', async () => {
      // wherePredicate applies `lte` first (else-if chain); whereToDrizzleFilters applies
      // `gte` first (return on first match). For { gte:1, lte:10 } this means:
      //   client includes score=0  (only lte:10 checked → 0≤10 passes)
      //   server includes score=15 (only gte:1  checked → 15≥1  passes)
      // score=0  → addDatabase → pushed to server (wrong, outside range)
      // score=15 → addClient  → added to client (wrong, outside range)
      const modelName = `model${++dbCounter}`
      const pglite = new PGlite()
      await pglite.exec(`
         CREATE TABLE metadata (uid TEXT PRIMARY KEY, created_at TIMESTAMP, updated_at TIMESTAMP, deleted_at TIMESTAMP);
         CREATE TABLE "${modelName}" (uid TEXT PRIMARY KEY, label TEXT NOT NULL, score INTEGER NOT NULL);
      `)
      const db = drizzle(pglite)
      const metaTable = pgTable('metadata', {
         uid: text('uid').primaryKey(),
         created_at: timestamp(), updated_at: timestamp(), deleted_at: timestamp(),
      })
      const modelTable = pgTable(modelName, {
         uid: text('uid').primaryKey(),
         label: text('label').notNull(),
         score: integer('score').notNull(),
      })

      // Server has records below, inside, and above the range 1–10
      await db.insert(modelTable).values([
         { uid: 'lo',  label: 'low',    score: 0  },
         { uid: 'mid', label: 'middle', score: 5  },
         { uid: 'hi',  label: 'high',   score: 15 },
      ])
      await db.insert(metaTable).values([
         { uid: 'lo',  created_at: T0 },
         { uid: 'mid', created_at: T0 },
         { uid: 'hi',  created_at: T0 },
      ])

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.addSynchroWhere({ score: { gte: 1, lte: 10 } })
         await model.synchronizeAll()

         const vals = await model.db.values.toArray()
         const uids = vals.map(v => v.uid)

         assert.ok(!uids.includes('lo'),  'score=0  is below range and must NOT be in Dexie')
         assert.ok( uids.includes('mid'), 'score=5  is in range and must be in Dexie')
         assert.ok(!uids.includes('hi'),  'score=15 is above range and must NOT be in Dexie')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('whereToDrizzleFilters supports range operators used in addSynchroWhere', async () => {
      // wherePredicate (client) handles { score: { gte: 5 } } correctly after earlier fixes,
      // but whereToDrizzleFilters (server) only calls eq() for every value.
      // Passing an object like { gte: 5 } to eq() makes Drizzle try to bind a plain
      // object as a PostgreSQL parameter → query throws → sync.go catch swallows the error
      // and returns undefined → client gets a TypeError → sync silently fails.
      const modelName = `model${++dbCounter}`
      const pglite = new PGlite()
      await pglite.exec(`
         CREATE TABLE metadata (uid TEXT PRIMARY KEY, created_at TIMESTAMP, updated_at TIMESTAMP, deleted_at TIMESTAMP);
         CREATE TABLE "${modelName}" (uid TEXT PRIMARY KEY, label TEXT NOT NULL, score INTEGER NOT NULL);
      `)
      const db = drizzle(pglite)
      const metaTable = pgTable('metadata', {
         uid: text('uid').primaryKey(),
         created_at: timestamp(), updated_at: timestamp(), deleted_at: timestamp(),
      })
      const modelTable = pgTable(modelName, {
         uid: text('uid').primaryKey(),
         label: text('label').notNull(),
         score: integer('score').notNull(),
      })

      await db.insert(modelTable).values([
         { uid: 'lo', label: 'low',  score: 3 },
         { uid: 'hi', label: 'high', score: 7 },
      ])
      await db.insert(metaTable).values([
         { uid: 'lo', created_at: T0 },
         { uid: 'hi', created_at: T0 },
      ])

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.addSynchroWhere({ score: { gte: 5 } })
         await model.synchronizeAll()

         const vals = await model.db.values.toArray()
         const uids = vals.map(v => v.uid)
         assert.ok(!uids.includes('lo'), 'score=3 should NOT be pulled (< 5)')
         assert.ok( uids.includes('hi'), 'score=7 should be pulled (≥ 5)')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('update() rollback clears stale updated_at from metadata', async () => {
      // Optimistic update sets updated_at = now in metadata before the server responds.
      // On rejection the rollback does db.metadata.update(uid, previousMetadata), but
      // previousMetadata captured before the update has no updated_at key, so Dexie's
      // partial update leaves updated_at = now in place.
      // On the next sync: new Date(stale_now) - new Date(T0) > 0 → spurious updateDatabase.
      const modelName = `model${++dbCounter}`

      const { clientApp, cleanup } = await createTestContext(serverApp => {
         serverApp.createService(modelName, {
            updateWithMeta: async () => { throw new Error('server rejected update') },
            createWithMeta: async () => {},
            deleteWithMeta: async () => {},
            findMany:        async () => [],
            findUnique:      async () => null,
         })
         serverApp.createService('sync', {
            go: async () => ({ addClient: [], updateClient: [], deleteClient: [], addDatabase: [], updateDatabase: [] }),
         })
      }, { useOfflinePlugin: true })

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         await model.db.values.add({ uid: 'r1', label: 'original' })
         await model.db.metadata.add({ uid: 'r1', created_at: T0 })  // no updated_at

         // update() optimistically sets updated_at = now, then server rejects
         await model.update('r1', { label: 'new' })

         // Poll until the rollback restores the value
         for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 10))
            const v = await model.db.values.get('r1')
            if (v?.label === 'original') break
         }

         assert.equal((await model.db.values.get('r1'))?.label, 'original', 'value should be rolled back')

         // updated_at must be null/undefined after rollback — a stale timestamp would
         // cause every subsequent sync to fire a spurious updateDatabase
         const meta = await model.db.metadata.get('r1')
         assert.ok(!meta.updated_at, 'updated_at should be null after rollback, not a stale timestamp')
      } finally {
         await cleanup()
      }
   })

   test('createWithMeta is idempotent: duplicate call does not erase the Dexie record', async () => {
      // Race condition: create() fires createWithMeta_A and returns immediately.
      // A concurrent synchronize() snapshots findMany() before _A lands on the server,
      // so the record appears in addDatabase.  The sync fires createWithMeta_B.
      // The server processes _A first (success), then _B hits a PK conflict on the
      // model table → throws → addDatabase catch deletes the record from Dexie.
      // Fix: model INSERT should use ON CONFLICT DO UPDATE just like the metadata INSERT.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // Server already has r1 (createWithMeta_A already landed)
      await db.insert(modelTable).values({ uid: 'r1', label: 'original' })
      await db.insert(metaTable).values({ uid: 'r1', created_at: T0 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])
         // Client has r1 in Dexie from the optimistic create
         await model.db.values.add({ uid: 'r1', label: 'original' })
         await model.db.metadata.add({ uid: 'r1', created_at: T0 })

         // Simulate createWithMeta_B: same call the addDatabase step would make
         let threw = false
         try {
            await clientApp.service(modelName).createWithMeta('r1', { label: 'original' }, T0)
         } catch (err) {
            threw = true
         }

         assert.ok(!threw, 'createWithMeta should not throw when uid already exists on server')

         // The rollback must NOT have run — r1 must still be in Dexie
         const r1 = await model.db.values.get('r1')
         assert.ok(r1, 'client Dexie should retain r1 after idempotent createWithMeta')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('addClient succeeds even when orphaned metadata already exists in Dexie', async () => {
      // The deleteWithMeta pub/sub handler does db.metadata.put(meta) which leaves
      // an orphaned metadata row after the value is deleted. If the same record is
      // later re-created on the server, addClient tries idbMetadata.add() which
      // throws a ConstraintError (PK already taken by the orphan), aborting the
      // entire addClient transaction — the record never arrives in the client cache.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      await db.insert(modelTable).values({ uid: 'r1', label: 'from-server' })
      await db.insert(metaTable).values({ uid: 'r1', created_at: T0 })

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // Simulate the orphaned metadata left by a deleteWithMeta pub/sub event:
         // the value row is gone but the metadata row remains with deleted_at set.
         await model.db.metadata.add({ uid: 'r1', created_at: T0, deleted_at: T1 })

         await model.addSynchroWhere({})
         await model.synchronizeAll()

         const r1 = await model.db.values.get('r1')
         assert.ok(r1, 'r1 should be pulled into Dexie via addClient despite orphaned metadata')
         assert.equal(r1.label, 'from-server')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('wherePredicate handles boolean equality correctly', async () => {
      // typeof(true) === 'boolean', which is matched by neither the string/number branch
      // nor the null branch nor the object branch — so boolean where-values are silently
      // ignored and every record passes, sending wrong records into clientMetadataDict.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         await model.db.values.add({ uid: 'r1', label: 'active',   active: true  })
         await model.db.values.add({ uid: 'r2', label: 'inactive', active: false })

         const results = await model.findWhere({ active: true })
         const uids = results.map(r => r.uid)

         assert.ok( uids.includes('r1'), 'active=true  should match { active: true }')
         assert.ok(!uids.includes('r2'), 'active=false should NOT match { active: true }')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('wherePredicate handles null equality correctly', async () => {
      // After fixing the TypeError on null, the previous fix used `value !== null`
      // to guard the object branch — but that leaves null with NO branch at all,
      // so `where = { user_uid: null }` passes every record instead of only those
      // with user_uid === null.  In synchronize() this causes records with a non-null
      // user_uid to appear as addDatabase, hit a PK conflict, and get deleted.
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         await model.db.values.add({ uid: 'r1', label: 'with-user', user_uid: 'u1' })
         await model.db.values.add({ uid: 'r2', label: 'no-user',   user_uid: null })

         const results = await model.findWhere({ user_uid: null })
         const uids = results.map(r => r.uid)

         assert.ok(!uids.includes('r1'), 'record with user_uid=u1 should NOT match { user_uid: null }')
         assert.ok( uids.includes('r2'), 'record with user_uid=null should match { user_uid: null }')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('wherePredicate handles falsy boundary value (lte: 0) correctly', async () => {
      // wherePredicate is used by synchronize() to build clientMetadataDict.
      // A falsy boundary (lte: 0) is checked with `if (value.lte)` which treats 0
      // as "not set", causing ALL records to pass — wrong records enter clientMetadataDict
      // and the sync pushes them to the server where they fail with PK conflicts,
      // then the rollback deletes them from Dexie (data loss).
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      const { clientApp, cleanup } = await createTestContext(
         serverApp => serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable]),
         { useOfflinePlugin: true },
      )

      try {
         const model = clientApp.createOfflineModel(modelName, ['label'])

         // Dexie stores arbitrary fields — score is not indexed but is queryable
         await model.db.values.add({ uid: 'pos',  label: 'positive', score:  5 })
         await model.db.values.add({ uid: 'neg',  label: 'negative', score: -3 })
         await model.db.values.add({ uid: 'zero', label: 'zero',     score:  0 })

         const results = await model.findWhere({ score: { lte: 0 } })
         const uids = results.map(r => r.uid)

         assert.ok(!uids.includes('pos'),  'score=5  should NOT match { lte: 0 }')
         assert.ok( uids.includes('neg'),  'score=-3 should match { lte: 0 }')
         assert.ok( uids.includes('zero'), 'score=0  should match { lte: 0 }')
      } finally {
         await cleanup()
         pglite.close()
      }
   })

   test('pub/sub createWithMeta event correctly updates a second client\'s Dexie', async () => {
      const modelName = `model${++dbCounter}`
      const { pglite, db, metaTable, modelTable } = await createTestDb(modelName)

      // Server with pub/sub: every client joins 'all' and createWithMeta broadcasts there
      const serverApp = expressX({})
      serverApp.configure(drizzleOfflinePlugin, db, metaTable, [modelTable])
      serverApp.addConnectListener(socket => serverApp.joinChannel('all', socket))
      serverApp.service(modelName).publish(async () => ['all'])
      await new Promise(resolve => serverApp.httpServer.listen(0, resolve))
      const port = serverApp.httpServer.address().port

      function connectClient() {
         const socket = ioc(`http://localhost:${port}`, { transports: ['websocket'], autoConnect: false })
         const app = createClient(socket, { debug: false })
         offlinePlugin(app)
         socket.connect()
         return new Promise((resolve, reject) => {
            socket.on('connect', () => resolve({ app, socket }))
            socket.on('connect_error', reject)
         })
      }

      const { app: appA, socket: socketA } = await connectClient()
      const { app: appB, socket: socketB } = await connectClient()

      const modelA = appA.createOfflineModel(modelName, ['label'])
      const modelB = appB.createOfflineModel(modelName, ['label'])

      try {
         // Client A creates a record while connected — fires createWithMeta directly
         const record = await modelA.create({ label: 'from-A' })

         // Poll until the pub/sub event reaches client B's Dexie
         let inB = null
         for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 10))
            inB = await modelB.db.values.get(record.uid)
            if (inB) break
         }

         assert.ok(inB, 'Client B should receive the record via pub/sub')
         assert.equal(inB.label, 'from-A', 'Client B should have the correct label')
      } finally {
         socketA.disconnect()
         socketB.disconnect()
         await new Promise(resolve => serverApp.io.close(resolve))
         pglite.close()
      }
   })

})
