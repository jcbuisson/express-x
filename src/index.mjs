
import http from 'http'
import { Server } from "socket.io"
import { PrismaClient } from '@prisma/client'

/*
 * Enhance `app` express application with Feathers-like services
 */
function expressX(app, options={}) {

   if (options.debug === undefined) options.debug = true
   if (options.ws === undefined) options.ws = { ws_prefix: "expressx" }

   const services = {}
   const connections = {}

   let lastConnectionId = 1

   /*
    * create a service `name` based on Prisma table `entity`
    */
   function createDatabaseService(name, { entity=name, client='prisma' }) {
      let prisma = app.get('prisma')
      if (!prisma) {
         prisma = new PrismaClient()
         app.set('prisma', prisma)
      }
      
      const service = createService(name, {
         create: (data) => {
            if (options.debug) console.log('create', name, data)
            return prisma[entity].create({
               data,
            })
         },

         get: (id) => {
            if (options.debug) console.log('get', name, id)
            return prisma[entity].findUnique({
               where: {
                  id,
               },
            })
         },

         patch: (id, data) => {
            if (options.debug) console.log('patch', name, id, data)
            return prisma[entity].update({
               where: {
                  id,
               },
               data,
            })
         },

         remove: (id) => {
            if (options.debug) console.log('remove', name, id)
            return prisma[entity].delete({
               where: {
                  id,
               },
            })},

         find: (options) => {
            if (options.debug) console.log('find', name, options)
            return prisma[entity].findMany(options)
         },

         upsert: (options) => {
            if (options.debug) console.log('upsert', name, options)
            return prisma[entity].upsert(options)
         },
      })
      if (options.debug) console.log(`created service '${name}' over table '${entity}'`)
      return service
   }

   /*
    * create a service `name` with given `methods`
    */
   function createService(name, methods) {
      const service = { name }

      for (const methodName in methods) {
         const method = methods[methodName]

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
               context = await hook({ ...context, args })
            }

            // call method
            const result = await method(...context.args)
            // if (options.debug) console.log('result', result)

            // call 'after' hooks
            const afterMethodHooks = service?.hooks?.after && service.hooks.after[methodName] || []
            const afterAllHooks = service?.hooks?.after?.all || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks]) {
               context = await hook({ ...context, result })
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
   function addHttpRest(path, service) {
      const context = {
         app,
         http: { name: service.name }
      }

      app.post(path, async (req, res) => {
         context.http.req = req
         const value = await service.__create(context, req.body)
         res.json(value)
      })

      app.get(path, async (req, res) => {
         context.http.req = req
         const values = await service.__find(context, req.body)
         res.json(values)
      })

      app.get(`${path}/:id`, async (req, res) => {
         context.http.req = req
         const value = await service.__get(context, parseInt(req.params.id))
         res.json(value)
      })

      app.patch(`${path}/:id`, async (req, res) => {
         context.http.req = req
         const value = await service.__patch(context, parseInt(req.params.id), req.body)
         res.json(value)
      })

      app.delete(`${path}/:id`, async (req, res) => {
         context.http.req = req
         const value = await service.__remove(context, parseInt(req.params.id))
         res.json(value)
      })

      if (options.debug) console.log(`added HTTP endpoints for service '${service.name}' at path '${path}'`)
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
         if (options.debug) console.log('Client connected to the WebSocket')
         const connection = {
            id: lastConnectionId++,
            socket,
            channelNames: new Set(),
         }
         // store connection in cache 
         connections[connection.id] = connection
         if (options.debug) console.log('active connections', Object.keys(connections))

         // emit 'connection' event for app (expressjs extends EventEmitter)
         app.emit('connection', connection)

         // send 'connected' event to client
         socket.emit('connected', connection.id)

         socket.on('disconnect', () => {
            if (options.debug) console.log('Client disconnected', connection.id)
            delete connections[connection.id]
         })


         /*
         * Handle websocket client request
         * Emit in return a 'client-response' message
         */
         socket.on('client-request', async ({ uid, name, action, args }) => {
            if (options.debug) console.log("client-request", uid, name, action, args)
            if (name in services) {
               const service = services[name]
               try {
                  const serviceMethod = service['__' + action]
                  if (serviceMethod) {
                     const context = {
                        app,
                        ws: { connection, name, action, args },
                     }

                     try {
                        const result = await serviceMethod(context, ...args)
                        socket.emit('client-response', {
                           uid,
                           result,
                        })
                        // pub/sub: send event on associated channels
                        const publishFunc = service.publishCallback
                        if (publishFunc) {
                           const channelNames = await publishFunc(result, app)
                           if (options.debug) console.log('publish channels', name, action, channelNames)
                           for (const channelName of channelNames) {
                              if (options.debug) console.log('service-event', name, action, channelName)
                              const connectionList = Object.values(connections).filter(cnx => cnx.channelNames.has(channelName))
                              for (const connection of connectionList) {
                                 if (options.debug) console.log('emit to', connection.id, name, action, result)
                                 connection.socket.emit('service-event', {
                                    name,
                                    action,
                                    result,
                                 })
                              }
                           }
                        }
                     } catch(callErr) {
                        console.log('callErr', callErr)
                        io.emit('client-response', {
                           uid,
                           error: callErr.toString(),
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

   function joinChannel(channelName, connection) {
      connection.channelNames.add(channelName)
   }

   function leaveChannel(channelName, connection) {
      connection.channelNames.delete(channelName)
   }

   // enhance `app` with objects and methods
   Object.assign(app, {
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
   return app
}

export default expressX
