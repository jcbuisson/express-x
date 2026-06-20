import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'

import { computeSyncResult } from '#root/src/server.mjs'

const T0 = new Date('2026-01-01T00:00:00Z')
const T1 = new Date('2026-01-02T00:00:00Z')
const T2 = new Date('2026-01-03T00:00:00Z')

// ─── Dialog helpers ────────────────────────────────────────────────────────────
// Lightweight simulations of server (drizzle-plugins.mjs) and client (client.mts)
// that run the sync protocol using plain objects instead of Dexie / PostgreSQL.

function matchesWhere(value, where) {
   return Object.entries(where).every(([k, v]) => value[k] === v)
}

describe('computeSyncResult', () => {

   test('both empty → all arrays empty', () => {
      const result = computeSyncResult({}, {}, {})
      assert.deepEqual(result.addClient, [])
      assert.deepEqual(result.updateClient, [])
      assert.deepEqual(result.deleteClient, [])
      assert.deepEqual(result.addDatabase, [])
      assert.deepEqual(result.updateDatabase, [])
      assert.deepEqual(result.deleteDatabase, [])
   })

   test('record only in DB → sent to client (addClient)', () => {
      const value = { uid: 'a', label: 'Vacances' }
      const meta  = { uid: 'a', created_at: T0 }
      const result = computeSyncResult({ a: value }, {}, { a: meta })
      assert.equal(result.addClient.length, 1)
      assert.deepEqual(result.addClient[0], [value, meta])
      assert.deepEqual(result.addDatabase, [])
   })

   test('record only on client, not deleted → sent to database (addDatabase)', () => {
      const clientMeta = { uid: 'b', created_at: T0 }
      const result = computeSyncResult({}, { b: clientMeta }, {})
      assert.deepEqual(result.addDatabase, [clientMeta])
      assert.deepEqual(result.addClient, [])
      assert.deepEqual(result.deleteClient, [])
   })

   test('record only on client, deleted → ignored on both sides (deleteClient)', () => {
      const clientMeta = { uid: 'c', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({}, { c: clientMeta }, {})
      assert.deepEqual(result.deleteClient, [['c', T1]])
      assert.deepEqual(result.addDatabase, [])
   })

   test('server tombstone newer than client copy → delete client, do not recreate DB', () => {
      const clientMeta = { uid: 'x', created_at: T0 }
      const dbTombstone = { uid: 'x', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({}, { x: clientMeta }, { x: dbTombstone })
      assert.deepEqual(result.deleteClient, [['x', T1]])
      assert.deepEqual(result.addDatabase, [])
      assert.deepEqual(result.updateDatabase, [])
   })

   test('client update newer than server tombstone → recreate database', () => {
      const clientMeta = { uid: 'y', created_at: T0, updated_at: T2 }
      const dbTombstone = { uid: 'y', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({}, { y: clientMeta }, { y: dbTombstone })
      assert.deepEqual(result.addDatabase, [clientMeta])
      assert.deepEqual(result.deleteClient, [])
      assert.deepEqual(result.updateDatabase, [])
   })

   test('server live metadata newer than client but row missing → tombstone server metadata and delete client', () => {
      const clientMeta = { uid: 'm', created_at: T0, updated_at: T1 }
      const dbMeta = { uid: 'm', created_at: T0, updated_at: T2 }
      const result = computeSyncResult({}, { m: clientMeta }, { m: dbMeta })
      assert.deepEqual(result.deleteDatabase, ['m'])
      assert.equal(result.deleteClient.length, 1)
      assert.equal(result.deleteClient[0][0], 'm')
      assert.equal(new Date(result.deleteClient[0][1]).getTime(), T2.getTime())
      assert.deepEqual(result.addDatabase, [])
   })

   test('record in both, server tombstone newer than client copy → delete stale DB row and client', () => {
      const value = { uid: 'z', label: 'stale-server-row' }
      const clientMeta = { uid: 'z', created_at: T0 }
      const dbTombstone = { uid: 'z', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({ z: value }, { z: clientMeta }, { z: dbTombstone })
      assert.deepEqual(result.deleteDatabase, ['z'])
      assert.deepEqual(result.deleteClient, [['z', T1]])
      assert.deepEqual(result.updateClient, [])
      assert.deepEqual(result.updateDatabase, [])
   })

   test('record in both, client newer → update database (updateDatabase)', () => {
      const value      = { uid: 'd', label: 'old' }
      const dbMeta     = { uid: 'd', created_at: T0, updated_at: T1 }
      const clientMeta = { uid: 'd', created_at: T0, updated_at: T2 }
      const result = computeSyncResult({ d: value }, { d: clientMeta }, { d: dbMeta })
      assert.deepEqual(result.updateDatabase, [clientMeta])
      assert.deepEqual(result.updateClient, [])
   })

   test('record in both, DB newer → update client (updateClient)', () => {
      const value      = { uid: 'e', label: 'new' }
      const dbMeta     = { uid: 'e', created_at: T0, updated_at: T2 }
      const clientMeta = { uid: 'e', created_at: T0, updated_at: T1 }
      const result = computeSyncResult({ e: value }, { e: clientMeta }, { e: dbMeta })
      assert.deepEqual(result.updateClient, [[value, dbMeta]])
      assert.deepEqual(result.updateDatabase, [])
   })

   test('sub-day timestamp matches its day-truncated DB counterpart → no action', () => {
      // The DB stores TIMESTAMP. Before this fix it stored DATE (day precision), which
      // caused new Date('2026-01-02T06:00:00Z') - new Date('2026-01-02') > 0, triggering
      // a spurious updateDatabase on every sync after the initial addDatabase push.
      const value      = { uid: 'p', label: 'precision' }
      const dbMeta     = { uid: 'p', created_at: '2026-01-02T06:00:00.000Z' }            // TIMESTAMP from server
      const clientMeta = { uid: 'p', created_at: new Date('2026-01-02T06:00:00.000Z') }  // full timestamp on client
      const result = computeSyncResult({ p: value }, { p: clientMeta }, { p: dbMeta })
      assert.deepEqual(result.updateDatabase, [], 'identical timestamps must not trigger spurious updateDatabase')
      assert.deepEqual(result.updateClient,   [])
   })

   test('record in both, same timestamp → no action', () => {
      const value      = { uid: 'f', label: 'same' }
      const dbMeta     = { uid: 'f', created_at: T0, updated_at: T1 }
      const clientMeta = { uid: 'f', created_at: T0, updated_at: T1 }
      const result = computeSyncResult({ f: value }, { f: clientMeta }, { f: dbMeta })
      assert.deepEqual(result.updateClient, [])
      assert.deepEqual(result.updateDatabase, [])
   })

   test('record in both, client deleted → delete on DB and notify client', () => {
      const value      = { uid: 'g', label: 'bye' }
      const dbMeta     = { uid: 'g', created_at: T0 }
      const clientMeta = { uid: 'g', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({ g: value }, { g: clientMeta }, { g: dbMeta })
      assert.deepEqual(result.deleteDatabase, ['g'])
      assert.deepEqual(result.deleteClient, [['g', T1]])
   })

   test('record in both, client delete newer than DB update → delete on DB and notify client', () => {
      const value      = { uid: 'h', label: 'server-old' }
      const dbMeta     = { uid: 'h', created_at: T0, updated_at: T1 }
      const clientMeta = { uid: 'h', created_at: T0, deleted_at: T2 }
      const result = computeSyncResult({ h: value }, { h: clientMeta }, { h: dbMeta })
      assert.deepEqual(result.deleteDatabase, ['h'])
      assert.deepEqual(result.deleteClient, [['h', T2]])
      assert.deepEqual(result.updateClient, [])
   })

   test('record in both, DB update newer than client delete → restore client from DB', () => {
      const value      = { uid: 'i', label: 'server-new' }
      const dbMeta     = { uid: 'i', created_at: T0, updated_at: T2 }
      const clientMeta = { uid: 'i', created_at: T0, deleted_at: T1 }
      const result = computeSyncResult({ i: value }, { i: clientMeta }, { i: dbMeta })
      assert.deepEqual(result.updateClient, [[value, dbMeta]])
      assert.deepEqual(result.deleteDatabase, [])
      assert.deepEqual(result.deleteClient, [])
   })

   test('mixed scenario: one of each case', () => {
      const dbOnly      = { uid: 'db', label: 'db-only' }
      const dbOnlyMeta  = { uid: 'db', created_at: T0 }

      const clientNewMeta = { uid: 'cn', created_at: T1 }

      const sharedValue       = { uid: 'sh', label: 'shared' }
      const sharedDbMeta      = { uid: 'sh', created_at: T0, updated_at: T1 }
      const sharedClientMeta  = { uid: 'sh', created_at: T0, updated_at: T2 }

      const result = computeSyncResult(
         { db: dbOnly, sh: sharedValue },
         { cn: clientNewMeta, sh: sharedClientMeta },
         { db: dbOnlyMeta, sh: sharedDbMeta },
      )

      assert.equal(result.addClient.length, 1)
      assert.deepEqual(result.addClient[0], [dbOnly, dbOnlyMeta])
      assert.deepEqual(result.addDatabase, [clientNewMeta])
      assert.deepEqual(result.updateDatabase, [sharedClientMeta])
      assert.deepEqual(result.updateClient, [])
      assert.deepEqual(result.deleteClient, [])
      assert.deepEqual(result.deleteDatabase, [])
   })

})
