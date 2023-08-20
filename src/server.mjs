
import http from 'http'
import { Server } from "socket.io"
import express from 'express'

/*
 * Enhance `app` express application with services and real-time features
 */
export function expressX(prisma, options = {}) {

   const app = express()

   if (options.ws === undefined) options.ws = { ws_prefix: "expressx" }

   const services = {}
   let appHooks = []

   const cnx2Socket = {}
   const cnx2Timer = {}

   async function createConnection(clientIP) {
      const connection = await prisma.Connection.create({
         data: {
            clientIP,
         }
      })
      return connection
   }

   function getConnection(id) {
      return prisma.Connection.findUnique({ where: { id }})
   }

   async function cloneConnection(id, connection) {
      await prisma.Connection.update({
         where: { id },
         data: {
            clientIP: connection.clientIP,
            channelNames: connection.channelNames,
            data: connection.data,
         }
      })
   }

   async function deleteConnection(id) {
      try {
         await prisma.Connection.delete({ where: { id }})
      } catch(err) {
         // it may be necessary in rare situations (not sure...)
      }
   }

   function getSocket(connectionId) {
      return cnx2Socket[connectionId]
   }

   function setSocket(connectionId, socket) {
      cnx2Socket[connectionId] = socket
   }


   function getTimer(connectionId) {
      return cnx2Timer[connectionId]
   }

   function setTimer(connectionId, timer) {
      cnx2Timer[connectionId] = timer
   }


   // logging function - a winston logger must be configured first
   app.log = (severity, message) => {
      const logger = app.get('logger')
      if (logger) logger.log(severity, message)
   }

   /*
    * create a service `name` based on Prisma table `entity`
    */
   function createDatabaseService(name, prismaOptions = { entity: name }) {
      // take all prisma methods on `entity` table
      const methods = prisma[prismaOptions.entity]

      const service = createService(name, methods)
      
      service.prisma = prisma
      service.entity = prismaOptions.entity
      
      app.log('info', `created service '${name}' over table '${prismaOptions.entity}'`)
      return service
   }

   /*
    * create a service `name` with given `methods`
    */
   function createService(name, methods) {
      const service = { name }

      for (const methodName in methods) {
         const method = methods[methodName]
         if (! method instanceof Function) continue

         // `context` is the context of execution (transport type, connection, app)
         // `args` is the list of arguments of the method
         service['__' + methodName] = async (context, ...args) => {
            context.args = args

            // if a hook or the method throws an error, it will be caught by `socket.on('client-request'` (ws)
            // or by express (http) and the client will get a rejected promise

            // call 'before' hooks, modifying `context`
            const beforeAppHooks = appHooks?.before || []
            const beforeMethodHooks = service?.hooks?.before && service.hooks.before[methodName] || []
            const beforeAllHooks = service?.hooks?.before?.all || []
            for (const hook of [...beforeAppHooks, ...beforeMethodHooks, ...beforeAllHooks]) {
               await hook(context)
            }

            // call method
            const result = await method(...context.args)
            // put result into context
            context.result = result

            // call 'after' hooks, modifying `context`
            const afterMethodHooks = service?.hooks?.after && service.hooks.after[methodName] || []
            const afterAllHooks = service?.hooks?.after?.all || []
            const afterAppHooks = appHooks?.after || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks, ...afterAppHooks]) {
               await hook(context)
            }

            // publish event (websocket transport)
            if (options.ws && service.publishFunction) {
               const channelNames = await service.publishFunction(result, app)
               app.log('verbose', `publish channels ${service.name} ${methodName} ${channelNames}`)
               const connections = await app.prisma.Connection.findMany({})
               for (const channelName of channelNames) {
                  app.log('verbose', `service-event ${service.name} ${methodName} ${channelName}`)
                  const connectionList = connections.filter(connection => {
                     const channelNames = JSON.parse(connection.channelNames)
                     return channelNames.includes(channelName)
                  })
            
                  for (const connection of connectionList) {
                     const trimmedResult = result ? JSON.stringify(result).slice(0, 300) : ''
                     app.log('verbose', `emit to ${connection.id} ${service.name} ${methodName} ${trimmedResult}`)
                     const socket = getSocket(connection.id)
                     // emit service event
                     socket && socket.emit('service-event', {
                        name: service.name,
                        action: methodName,
                        result,
                     })
                  }
               }
            }
            
            return context.result
         }

         // TODO: NOT CLEAR AND PROBABLY USELESS
         // hooked version of method: `create`, etc., to be called from backend with no context
         service[methodName] = method
         // un-hooked version of method: `_create`, etc., to be called from backend with no context
         service['_' + methodName] = method
      }

      // attach pub/sub publish callback
      service.publish = async (func) => {
         service.publishFunction = func
      },

      // attach hooks
      service.hooks = (hooks) => {
         service.hooks = hooks
      }

      // cache service in `services`
      services[name] = service
      return service
   }

   // `app.service(name)` starts here!
   function service(name) {
      // get service from `services` cache
      if (name in services) return services[name]
      throw Error(`there is no service named '${name}'`)
   }

   function configure(callback) {
      callback(app)
   }

   // set application hooks
   function hooks(hooks) {
      appHooks = hooks
   }

   /*
    * add an HTTP REST endpoint at `path`, based on `service`
    */
   async function addHttpRest(path, service) {
      const context = {
         app,
         transport: 'http',
         params: { name: service.name }
      }

      // introspect schema and return a map: field name => prisma type
      async function getTypesMap() {
         const dmmf = await service.prisma._getDmmf()
         const fieldDescriptions = dmmf.modelMap[service.name].fields
         return fieldDescriptions.reduce((accu, descr) => {
            accu[descr.name] = descr.type
            return accu
         }, {})
      }


      app.post(path, async (req, res) => {
         app.log('verbose', `http request POST ${req.url}`)
         context.params.req = req
         try {
            const value = await service.__create(context, { data: req.body })
            res.json(value)
         } catch(err) {
            app.log('error', err)
            res.status(500).send(err.toString())
         }
      })

      app.get(path, async (req, res) => {
         app.log('verbose', `http request GET ${req.url}`)
         context.params.req = req
         const query = { ...req.query }
         try {
            // the values in `req.query` are all strings, but Prisma need proper types
            // we need to introspect column types and do the proper transtyping
            for (const fieldName in query) {
               const typesDict = await getTypesMap()
               const fieldType = typesDict[fieldName]

               if (fieldType === 'Int') {
                  query[fieldName] = parseInt(query[fieldName])
               } else if (fieldType === 'Float') {
                  query[fieldName] = parseFloat(query[fieldName])
               } else if (fieldType === 'Boolean') {
                  query[fieldName] = (query[fieldName] === 't') ? true : false
               } else if (fieldType === 'String') {
                  query[fieldName] = query[fieldName]
               } else {
                  // ?
                  query[fieldName] = query[fieldName]
               }
            }
            // call __findMany
            const values = await service.__findMany(context, {
               where: query,
            })
            res.json(values)
         } catch(err) {
            app.log('error', err)
            res.status(500).send(err.toString())
         }
      })

      app.get(`${path}/:id`, async (req, res) => {
         app.log('verbose', `http request GET ${req.url}`)
         context.params.req = req
         try {
            const value = await service.__findUnique(context, {
               where: {
                  id: parseInt(req.params.id)
               }
            })
            res.json(value)
         } catch(err) {
            app.log('error', err)
            res.status(500).send(err.toString())
         }
      })

      app.patch(`${path}/:id`, async (req, res) => {
         app.log('verbose', `http request PATCH ${req.url}`)
         context.params.req = req
         try {
            const value = await service.__update(context, {
               where: {
                  id: parseInt(req.params.id),
               },
               data: req.body,
            })
            res.json(value)
         } catch(err) {
            app.log('error', err)
            res.status(500).send(err.toString())
         }
      })

      app.delete(`${path}/:id`, async (req, res) => {
         app.log('verbose', `http request DELETE ${req.url}`)
         context.params.req = req
         try {
            const value = await service.__delete(context, {
               where: {
                  id: parseInt(req.params.id)
               }
            })
            res.json(value)
         } catch(err) {
            app.log('error', err)
            res.status(500).send(err.toString())
         }
      })

      app.log('info', `added HTTP endpoints for service '${service.name}' at path '${path}'`)
   }

   /*
    * Create HTTP server
   */
   const server = new http.Server(app)

   if (options.ws) {
      /*
      * Add websocket transport
      */
      const io = new Server(server)
      
      io.on('connection', async function(socket) {
         const clientIP = socket.request?.connection?.remoteAddress || 'unknown'
         const connection = await createConnection(clientIP)
         app.log('verbose', `Client connected ${connection.id} from IP ${clientIP}`)

         setSocket(connection.id, socket)

         // emit 'connection' event for app (expressjs extends EventEmitter)
         console.log('EMIT CONNECTION')
         app.emit('connection', connection)

         // send 'connected' event to client
         socket.emit('connected', connection.id)

         socket.on('disconnect', () => {
            app.log('verbose', `Client disconnected ${connection.id}`)

            // remove connection record after 1mn (leaves time in case of connection transfer)
            setTimeout(async () => {
               const connectionId = connection.id
               // check if connection still exists
               const cnx = await getConnection(connectionId)
               if (cnx) {
                  app.log('verbose', `Delete connection ${connectionId}`)
                  await deleteConnection(connectionId)
               }
            }, 10 * 1000)
         })

         
         // handle connection data transfer caused by a disconnection/reconnection (page reload, network issue, etc.)
         socket.on('cnx-transfer', async ({ from, to }) => {
            app.log('verbose', `cnx-transfer from ${from} to ${to}`)
            const fromConnection = await getConnection(from)
            if (!fromConnection) return
            await cloneConnection(to, fromConnection)
            setSocket(to, socket)
            await deleteConnection(from)
            // send acknowledge to client
            io.emit('cnx-transfer-ack', to)
         })

         /*
         * Handle websocket client request
         * Emit in return a 'client-response' message
         */
         socket.on('client-request', async ({ uid, name, action, args }) => {
            app.log('verbose', `client-request ${uid} ${name} ${action} ${JSON.stringify(args)}`)
            if (name in services) {
               const service = services[name]
               try {
                  const serviceMethod = service['__' + action]
                  if (serviceMethod) {
                     const context = {
                        app,
                        transport: 'ws',
                        params: { connectionId: connection.id, name, action, args },
                     }

                     try {
                        const result = await serviceMethod(context, ...args)
                        const trimmedResult = result ? JSON.stringify(result).slice(0, 300) : ''
                        app.log('verbose', `client-response ${uid} ${trimmedResult}`)
                        socket.emit('client-response', {
                           uid,
                           result,
                        })
                     } catch(err) {
                        app.log('error', err.toString())
                        io.emit('client-response', {
                           uid,
                           error: err.toString(),
                        })
                     }
                  } else {
                     io.emit('client-response', {
                        uid,
                        error: `there is no method named '${action}' for service '${name}'`,
                     })
                  }
               } catch(error) {
                  io.emit('client-response', {
                     uid,
                     error,
                  })
               }
            } else {
               io.emit('client-response', {
                  uid,
                  error: `there is no service named '${name}'`,
               })
            }
         })
      })      
   }
   
   async function joinChannel(channelName, connection) {
      app.log('verbose', `Joining channel ${channelName} ${connection.id}`)
      const channelNames = JSON.parse(connection.channelNames)
      if (!channelNames.includes(channelName)) channelNames.push(channelName)
      await app.prisma.Connection.update({
         where: { id: connection.id },
         data: { channelNames: JSON.stringify(channelNames) },
      })
   }

   async function leaveChannel(channelName, connection) {
      app.log('verbose', `Leaving channel ${channelName} ${connection.id}`)
      const channelNames = JSON.parse(connection.channelNames).filter(name => name !== channelName)
      await app.prisma.Connection.update({
         where: { id },
         data: { channelNames: JSON.stringify(channelNames) },
      })
   }


   // enhance `app` with objects and methods
   return Object.assign(app, {
      prisma,
      options,
      getSocket, setSocket,
      getTimer, setTimer,
      createDatabaseService,
      createService,
      service,
      configure,
      hooks,
      addHttpRest,
      server,
      joinChannel,
      leaveChannel,
   })
}
