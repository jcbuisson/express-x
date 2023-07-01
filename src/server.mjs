
import http from 'http'
import { Server } from "socket.io"
import express from 'express'

/*
 * Enhance `app` express application with services and real-time features
 */
export function expressX(prisma, options = {}) {

   const app = express()
   app.set('prisma', prisma)

   if (options.ws === undefined) options.ws = { ws_prefix: "expressx" }

   const services = {}

   app.connections = {}
   let lastConnectionId = options.lastConnectionId || 1

   app.printCnx = (label) => {
      console.log(label)
      for (const id in app.connections) {
         console.log(`CNX ${id}, data ${JSON.stringify(app.connections[id].data)}`)
      }
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

            // call 'before' hooks, modifying `context.args`
            const beforeMethodHooks = service?.hooks?.before && service.hooks.before[methodName] || []
            const beforeAllHooks = service?.hooks?.before?.all || []
            for (const hook of [...beforeMethodHooks, ...beforeAllHooks]) {
               await hook(context)
            }

            // call method
            const result = await method(...context.args)
            // put result into context
            context.result = result
   
            // call 'after' hooks
            const afterMethodHooks = service?.hooks?.after && service.hooks.after[methodName] || []
            const afterAllHooks = service?.hooks?.after?.all || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks]) {
               await hook(context)
            }
            return result
         }

         // hooked version of method: `create`, etc., to be called from backend with no context
         service[methodName] = method

         // un-hooked version of method: `_create`, etc., to be called from backend with no context
         service['_' + methodName] = method
      }

      // attach pub/sub publish callback
      service.publish = async (func) => {
         service.publishCallback = func
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
            publish(service, 'create', value)
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
            publish(service, 'findMany', values)
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
            publish(service, 'findUnique', value)
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
            publish(service, 'update', value)
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
            publish(service, 'delete', value)
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
      
      io.on('connection', function(socket) {
         app.log('verbose', 'Client connected to the WebSocket')
         const connection = {
            id: lastConnectionId++,
            socket,
            channelNames: new Set(),
            data: {
               a: 123
            },
         }
         // store connection in cache 
         app.connections[connection.id] = connection
         app.log('verbose', `Connection ids: ${Object.keys(app.connections)}`)

         // emit 'connection' event for app (expressjs extends EventEmitter)
         app.emit('connection', connection)

         // send 'connected' event to client
         socket.emit('connected', connection.id)

         socket.on('disconnect', () => {
            app.log('verbose', `Client disconnected ${connection.id}`)

            // remove connection record after 1mn (leaves time in case of connection transfer)
            setTimeout(() => {
               app.log('verbose', `Delete connection ${connection.id}`)
               delete app.connections[connection.id]
            }, 60 * 1000)
         })

         
         // handle connection data transfer caused by a disconnection/reconnection (page reload, network issue, etc.)
         socket.on('cnx-transfer', async ({ from, to }) => {
            app.log('verbose', `cnx-transfer from ${from} to ${to}`)
            if (!app.connections[from]) return
            app.connections[to] = app.connections[from]
            app.connections[to].socket = socket
            delete app.connections[from]
            // app.printCnx('AFTER TRANSFER')
         })


         /*
         * Handle websocket client request
         * Emit in return a 'client-response' message
         */
         socket.on('client-request', async ({ uid, name, action, args }) => {
            app.log('verbose', `client-request ${uid} ${name} ${action} ${args}`)
            if (name in services) {
               const service = services[name]
               try {
                  const serviceMethod = service['__' + action]
                  if (serviceMethod) {
                     const context = {
                        app,
                        transport: 'ws',
                        params: { connection, name, action, args },
                     }

                     try {
                        const result = await serviceMethod(context, ...args)
                        app.log('verbose', `client-response ${uid} ${JSON.stringify(result)}`)
                        socket.emit('client-response', {
                           uid,
                           result,
                        })
                        // pub/sub: send event on associated channels
                        publish(service, action, result)
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

   // publish event on associated channels
   async function publish(service, action, result) {
      const publishFunc = service.publishCallback
      if (publishFunc) {
         const channelNames = await publishFunc(result, app)
         app.log('verbose', `publish channels ${service.name} ${action} ${channelNames}`)
         for (const channelName of channelNames) {
            app.log('verbose', `service-event ${service.name} ${action} ${channelName}`)
            const connectionList = Object.values(app.connections).filter(cnx => cnx.channelNames.has(channelName))
            for (const connection of connectionList) {
               app.log('verbose', `emit to ${connection.id} ${service.name} ${action} ${result}`)
               connection.socket.emit('service-event', {
                  name: service.name,
                  action,
                  result,
               })
            }
         }
      }
   }

   function joinChannel(channelName, connection) {
      connection.channelNames.add(channelName)
   }

   function leaveChannel(channelName, connection) {
      connection.channelNames.delete(channelName)
   }

   // enhance `app` with objects and methods
   return Object.assign(app, {
      options,
      createDatabaseService,
      createService,
      service,
      configure,
      addHttpRest,
      server,
      joinChannel,
      leaveChannel,
   })
}
