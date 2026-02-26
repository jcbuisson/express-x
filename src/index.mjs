import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"
import bcrypt from 'bcryptjs'




// UTILISER L'ACKNOWLEDGEMENT : https://socket.io/docs/v4/#acknowledgements




//////////////////////////       UTILITIES       //////////////////////////

function truncateString(str, maxLength = 300, ellipsis = '...') {
   // Check if the string already fits
   if (str.length <= maxLength) return str;
   // Calculate the cut-off point, accounting for the ellipsis length
   const cutLength = maxLength - ellipsis.length;
   // Ensure the string is long enough to be cut
   if (cutLength < 0) return str.substring(0, maxLength); // Just cut it off if ellipsis doesn't fit
   // Truncate the string and add the ellipsis
   return str.substring(0, cutLength) + ellipsis;
}


class Mutex {
   constructor() {
      this.locked = false;
      this.queue = [];
   }

   async acquire() {
      if (this.locked) {
         return new Promise(resolve => this.queue.push(resolve));
      }
      this.locked = true;
   }

   release() {
      if (this.queue.length > 0) {
         const next = this.queue.shift();
         next();
      } else {
         this.locked = false;
      }
   }
}

//////////////////////////       EXPRESSX       //////////////////////////

export function expressX(config) {

   const services = {}
   const socketConnectListeners = []
   const socketDisconnectingListeners = []
   const socketDisconnectListeners = []


   function addConnectListener(func) {
      socketConnectListeners.push(func)
   }

   function addDisconnectingListener(func) {
      socketDisconnectingListeners.push(func)
   }

   function addDisconnectListener(func) {
      socketDisconnectListeners.push(func)
   }

   const app = express()
   const httpServer = createServer(app)

   // so that config can be accessed anywhere with app.get('config')
   app.set('config', config)

   const io = new Server(httpServer, {
      path: config?.WS_PATH || '/socket.io/',
      connectionStateRecovery: {
         // the backup duration of the sessions and the packets
         maxDisconnectionDuration: 2 * 60 * 1000,
         // whether to skip middlewares upon successful recovery
         skipMiddlewares: true,
      }
   })

   // so that io server is accessible to hooks & services
   app.set('io', io)

   // logging function - a winston logger must be configured first
   app.log = (severity, message) => {
      const logger = app.get('logger')
      if (logger) logger.log(severity, message); else console.log(`[${severity}]`, message)
   }

   io.on('connection', async function(socket) {
      if (socket.recovered) {
         // recovery was successful: socket.id, socket.rooms and socket.data were restored
         // (network/Wifi disconnections)
         console.log('reconnection!!!', socket.id, socket.data)
      } else {
         // new or unrecoverable connection
         // (page open, page refresh/reload)
      }

      app.log('verbose', `Client connected ${socket.id}`)

      // emit 'connection' event for app (expressjs extends EventEmitter)
      app.emit('connection', socket)

      socketConnectListeners.forEach(listener => listener(socket))

      // send 'connected' event to client
      socket.emit('connected', socket.id)

      socket.on('disconnecting', (reason) => {
         app.log('verbose', `Client disconnecting ${socket.id}, ${reason}`)
         socketDisconnectingListeners.forEach(listener => listener(socket, reason))
      })

      socket.on('disconnect', (reason) => {
         app.log('verbose', `Client disconnect ${socket.id}, ${reason}`)
         socketDisconnectListeners.forEach(listener => listener(socket, reason))
      })

      /*
      * Handle websocket client request
      * Emit in return a 'client-response' message
      */
      socket.on('client-request', async ({ uid, name, action, args }) => {
         const trimmedArgs = args ? JSON.stringify(args).slice(0, 300) : ''
         app.log('verbose', `client-request ${uid} ${name} ${action} ${trimmedArgs}`)
         if (name in services) {
            const service = services[name]
            try {
               const serviceMethod = service['__' + action]
               if (serviceMethod) {
                  const context = {
                     app,
                     caller: 'client',
                     transport: 'ws',
                     socket,
                     // connectionId,
                     serviceName: name,
                     methodName: action,
                     args,
                  }

                  try {
                     // call method with context
                     if (name === 'highlighted_part') {
                        console.log('')
                     }
                     const result = await serviceMethod(context, ...args)

                     const trimmedResult = result ? JSON.stringify(result).slice(0, 300) : ''
                     app.log('verbose', `client-response ${uid} ${trimmedResult}`)
                     socket.emit('client-response', {
                        uid,
                        result,
                     })
                  } catch(err) {
                     console.log('!!!!!!error', 'name', name, 'action', action, 'args', args, 'err.code', err.code, 'err.message', err.message)
                     app.log('verbose', err.stack)
                     socket.emit('client-response', {
                        uid,
                        error: {
                           code: err.code || 'unknown-error',
                           message: err.message,
                           stack: err.stack,
                        }
                     })
                  }
               } else {
                  socket.emit('client-response', {
                     uid,
                     error: {
                        code: 'missing-method',
                        message: `there is no method named '${action}' for service '${name}'`,
                     }
                  })
               }
            } catch(err) {
               console.log('err', err)
               app.log('verbose', err.stack)
               socket.emit('client-response', {
                  uid,
                  error: {
                     code: err.code || 'unknown-error',
                     message: err.message,
                     stack: err.stack,
            }
               })
            }
         } else {
            socket.emit('client-response', {
               uid,
               error: {
                  code: 'missing-service',
                  message: `there is no service named '${name}'`,
               }
            })
         }
      })

   })

   /*
    * create a service `name` with given `methods`
    */
   function createService(name, methods) {
      const service = {}

      for (const methodName in methods) {
         const method = methods[methodName]
         if (! method instanceof Function) continue

         // `context` is the context of execution (transport type, connection, app)
         // `args` is the list of arguments of the method
         service['__' + methodName] = async (context, ...args) => {
            // put args into context
            context.args = args

            // if a hook or the method throws an error, it will be caught by `socket.on('client-request'`
            // and the client will get a rejected promise

            // call 'before' hooks, possibly modifying `context`
            const beforeMethodHooks = service?._hooks?.before && service._hooks.before[methodName] || []
            const beforeAllHooks = service?._hooks?.before?.all || []
            for (const hook of [...beforeAllHooks, ...beforeMethodHooks]) {
               await hook(context)
            }

            // call method
            const result = await method(...args)
            // put result into context
            context.result = result

            // call 'after' hooks, possibly modifying `context`
            const afterMethodHooks = service?._hooks?.after && service._hooks.after[methodName] || []
            const afterAllHooks = service?._hooks?.after?.all || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks]) {
               await hook(context)
            }

            // publish 'service-event' event associated to service/method
            if (service.publishFunction) {
               // collect channel names to socket is member of
               const channelNames = await service.publishFunction(context)
               // send event on all these channels
               if (channelNames.length > 0) {
                  app.log('verbose', `publish channels ${name} ${methodName} ${channelNames}`)
                  let sender = io.to(channelNames[0])
                  for (let i = 1; i < channelNames.length; i++) {
                     sender = sender.to(channelNames[i])
                  }
                  sender.emit('service-event', {
                     name,
                     action: methodName,
                     result,
                  })
               }
            }
            
            return context.result
         }

         // hooked version of method to be used server-side
         service[methodName] = (...args) => {
            const context = {
               app,
               caller: 'server',
               serviceName: service._name,
               methodName,
               args,
            }
            const hookedMethod = service['__' + methodName]
            return hookedMethod(context, ...args)
         }
      }

      // attach pub/sub publish callback
      service.publish = async (func) => {
         service.publishFunction = func
      },

      // attach hooks
      service.hooks = (hooks) => {
         service._hooks = hooks
      }

      // cache service in `services`
      services[name] = service
      return service
   }

   function configure(callback, ...args) {
      callback(app, ...args)
   }

   // `app.service(name)` starts here!
   function service(name) {
      // get service from `services` cache
      if (name in services) return services[name]
      app.log('error', `there is no service named '${name}'`, 'missing-service')
   }

   function joinChannel(channelName, socket) {
      app.log('verbose', `joining ${channelName}, ${JSON.stringify(socket.data)}`)
      socket.join(channelName)
   }

   function leaveChannel(channelName, socket) {
      app.log('verbose', `leaving ${channelName}, ${JSON.stringify(socket.data)}`)
      socket.leave(channelName)
   }

   // There is a need for events sent outside any service method call, for example on unsolicited-by-frontend backend state change
   async function sendAppEvent(channelName, type, value) {
      console.log('sendAppEvent', channelName, type, value)
      io.to(channelName).emit('app-event', { type, value })
   }

   // enhance `app` with objects and methods
   return Object.assign(app, {
      io,
      httpServer,
      createService,
      service,
      configure,
      joinChannel,
      leaveChannel,
      sendAppEvent,
      addConnectListener,
      addDisconnectingListener,
      addDisconnectListener,
   })
}

export class EXError extends Error {
   constructor(code, message) {
      super(message)
      this.code = code
   }
}


//////////////////////////       HOOK METHODS       //////////////////////////

/*
 * Add a timestamp property of name `field` with current time as value
*/
export const addTimestamp = (field) => async (context) => {
   context.result[field] = (new Date()).toISOString()
}

/*
 * Hash password of the property `field`
*/
export const hashPassword = (passwordField) => async (context) => {
   const user = context.result
   user[passwordField] = await bcrypt.hash(user[passwordField], 5)
}

/*
 * Remove `field` from `context.result`
*/
export const protect = (field) => (context) => {
   if (context.result) {
      if (Array.isArray(context.result)) {
         for (const value of context.result) {
            delete value[field]
         }
      } else if (typeof context.result === "object") {
         delete context.result[field]
      }
   }
}


//////////////////////////       RELOAD PLUGIN       //////////////////////////

export const roomCache = {}
export const dataCache = {}


export async function reloadPlugin(app) {

   const io = app.get('io')

   app.addDisconnectingListener((socket, reason) => {
      console.log('onSocketDisconnecting', socket.id, reason)
      // save socket data & rooms in caches
      const alreadySavedData = dataCache[socket.id]
      const alreadySavedRooms = roomCache[socket.id]

      dataCache[socket.id] = Object.assign({}, socket.data)
      roomCache[socket.id] = new Set(socket.rooms)

      if (alreadySavedData) dataCache[socket.id] = Object.assign(dataCache[socket.id], alreadySavedData)
      if (alreadySavedRooms) roomCache[socket.id].add(alreadySavedRooms)
   })

   app.addConnectListener((socket) => {
      console.log('onSocketConnect', socket.id)
   
      // when client ask for transfer from fromSocketId to toSocketId
      socket.on('cnx-transfer', async (fromSocketId, toSocketId) => {
         app.log('verbose', `cnx-transfer from ${fromSocketId} to ${toSocketId}`)
         console.log('dataCache', dataCache)
         console.log('roomCache', roomCache)
         // copy connection room & data from 'fromSocketId' to 'toSocketId'
         const toSocket = io.sockets.sockets.get(toSocketId)
         // data & rooms of fromSocketId are taken from dataCache and roomCache, since socket no longer exists
         const fromSocketRooms = roomCache[fromSocketId]
         if (toSocket && fromSocketRooms) {
            // copy rooms
            for (const room of fromSocketRooms) {
               if (room === fromSocketId) continue // do not include room associated to socket#id
               toSocket.join(room)
            }
            // copy data
            toSocket.data = dataCache[fromSocketId]
            // console.log('cnx-transfer data', toSocket.data)
            // console.log('cnx-transfer rooms', toSocket.rooms)
            // remove 'from' cache data
            delete roomCache[fromSocketId]
            delete dataCache[fromSocketId]
            // send acknowlegment to toSocket
            toSocket.emit('cnx-transfer-ack', fromSocketId, toSocketId)
         } else {
            console.log(`*** CNX TRANSFER ERROR, ${fromSocketId} -> ${toSocketId}`)
            toSocket.emit('cnx-transfer-error', fromSocketId, toSocketId)
         }
      })
   })
}


//////////////////////////       OFFLINE PLUGIN       //////////////////////////

const mutex = new Mutex()

export function offlinePlugin(app, modelNames) {

   const prisma = app.get('prisma');

   if (!prisma.metadata) {
      app.log('error', "A model named 'metadata' is expected in the prisma database - see https://expressx.jcbuisson.dev/server-api.html#offline")
      return
   }

   // add a database service for each model
   for (const modelName of modelNames) {
      const model = prisma[modelName];

      app.createService(modelName, {

         findUnique: model.findUnique,
         findMany: model.findMany,
         
         createWithMeta: async (uid, data, created_at) => {
            const [value, meta] = await prisma.$transaction([
               model.create({ data: { uid, ...data } }),
               prisma.metadata.create({ data: { uid, created_at } })
            ])
            return [value, meta]
         },
         
         updateWithMeta: async (uid, data, updated_at) => {
            const [value, meta] = await prisma.$transaction([
               model.update({ where: { uid }, data }),
               prisma.metadata.update({ where: { uid }, data: { updated_at } })
            ])
            return [value, meta]
         },
         
         deleteWithMeta: async (uid, deleted_at) => {
            const [value, meta] = await prisma.$transaction([
               model.delete({ where: { uid } }),
               prisma.metadata.update({ where: { uid }, data: { deleted_at } })
            ])
            return [value, meta]
         },
      })
   }

   // add a synchronization service
   app.createService('sync', {

      // AMÉLIORER : ne pas avoir une exclusion mutuelle globale, mais seulement par model/where
      go: async (modelName, where, cutoffDate, clientMetadataDict) => {
         await mutex.acquire()
         try {
            console.log('>>>>> SYNC', modelName, where, cutoffDate)
            const databaseService = app.service(modelName)
            const prisma = app.get('prisma')
      
            // STEP 1: get existing database `where` values
            const databaseValues = await databaseService.findMany({ where })
         
            const databaseValuesDict = databaseValues.reduce((accu, value) => {
               accu[value.uid] = value
               return accu
            }, {})
            // console.log('clientMetadataDict', clientMetadataDict)
            // console.log('databaseValuesDict', databaseValuesDict)
         
            // STEP 2: compute intersections between client and database uids
            const onlyDatabaseIds = new Set()
            const onlyClientIds = new Set()
            const databaseAndClientIds = new Set()
         
            for (const uid in databaseValuesDict) {
               if (uid in clientMetadataDict) {
                  databaseAndClientIds.add(uid)
               } else {
                  onlyDatabaseIds.add(uid)
               }
            }
         
            for (const uid in clientMetadataDict) {
               if (uid in databaseValuesDict) {
                  databaseAndClientIds.add(uid)
               } else {
                  onlyClientIds.add(uid)
               }
            }
            // console.log('onlyDatabaseIds', onlyDatabaseIds)
            // console.log('onlyClientIds', onlyClientIds)
            // console.log('databaseAndClientIds', databaseAndClientIds)
         
            // STEP 3: build add/update/delete sets
            const addDatabase = []
            const updateDatabase = []
            const deleteDatabase = []
         
            const addClient = []
            const updateClient = []
            const deleteClient = []
         
            for (const uid of onlyDatabaseIds) {
               const databaseValue = databaseValuesDict[uid]
               let databaseMetaData = await prisma.metadata.findUnique({ where: { uid }})
               if (!databaseMetaData) {
                  console.log('no metadata - should not happen', modelName, where, uid)
                  databaseMetaData = { uid, created_at: new Date() }
               }
               addClient.push([databaseValue, databaseMetaData])
            }
         
            for (const uid of onlyClientIds) {
               const clientMetaData = clientMetadataDict[uid]
               if (clientMetaData.deleted_at) {
                  deleteClient.push([uid, clientMetaData.deleted_at])
               } else if (new Date(clientMetaData.created_at) > cutoffDate) {
                  addDatabase.push(clientMetaData)
               } else {
                  // ???
               }
            }
         
            for (const uid of databaseAndClientIds) {
               const databaseValue = databaseValuesDict[uid]
               const clientMetaData = clientMetadataDict[uid]
                  || { uid, created_at: new Date() } // should not happen
               if (clientMetaData.deleted_at) {
                  deleteDatabase.push(uid)
                  deleteClient.push([uid, clientMetaData.deleted_at])
               } else {
                  const databaseMetaData = await prisma.metadata.findUnique({ where: { uid }})
                     || { uid, created_at: new Date() } // should not happen
                  const clientUpdatedAt = new Date(clientMetaData.updated_at || clientMetaData.created_at)
                  const databaseUpdatedAt = new Date(databaseMetaData.updated_at || databaseMetaData.created_at)
                  const dateDifference = clientUpdatedAt - databaseUpdatedAt
                  // console.log('databaseMetaData', databaseMetaData, 'clientMetaData', clientMetaData, 'dateDifference', dateDifference)
                  if (dateDifference > 0) {
                     updateDatabase.push(clientMetaData)
                  } else if (dateDifference < 0) {
                     updateClient.push(databaseValue)
                  }
               }
            }
            console.log('addDatabase', truncateString(JSON.stringify(addDatabase)))
            console.log('deleteDatabase', truncateString(JSON.stringify(deleteDatabase)))
            console.log('updateDatabase', truncateString(JSON.stringify(updateDatabase)))
         
            console.log('addClient', truncateString(JSON.stringify(addClient)))
            console.log('deleteClient', truncateString(JSON.stringify(deleteClient)))
            console.log('updateClient', truncateString(JSON.stringify(updateClient)))
         
            // STEP4: execute database deletions
            for (const uid of deleteDatabase) {
               const clientMetaData = clientMetadataDict[uid]
               // console.log('---delete', uid, clientMetaData)
               await databaseService.deleteWithMeta(uid, clientMetaData.deleted_at)
            }
         
            // STEP5: return to client the changes to perform on its cache, and create/update to perform on database with full data
            // database creations & updates are done later by the client with complete data (this function only has client values's meta-data)
            return {
               toAdd: addClient,
               toUpdate: updateClient,
               toDelete: deleteClient,

               addDatabase,
               updateDatabase,
            }
         } catch(err) {
            console.log('*** err sync', err)
         } finally {
            mutex.release()
         }
      },
   })

}
