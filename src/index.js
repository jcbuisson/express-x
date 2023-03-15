
import http from 'http'
import { Server } from "socket.io"
import { PrismaClient } from '@prisma/client'

/*
 * Enhance `app` express application with Feathers-like services
 */
function expressX(app) {
   const prisma = new PrismaClient()
   app.set('prisma', prisma) // ?? BOF

   const services = {}
   const connections = {}

   let lastConnectionId = 1

   /*
    * create a service `name` based on Prisma table `entity`
    */
   function createDatabaseService(name, { entity=name, client='prisma' }) {
      return createService(name, {
         create: (data) => prisma[entity].create({
            data,
         }),

         get: (id) => prisma[entity].findUnique({
            where: {
               id,
            },
         }),

         patch: (id, data) => prisma[entity].update({
            where: {
               id,
            },
            data,
         }),

         remove: (id, data) => prisma[entity].delete({
            where: {
               id,
            },
         }),

         find: (options) => prisma[entity].findMany(options),
      })
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

            // if a hook or the method throws an error, it will be caught by `socket.on('client-request'`
            // and the client will get a rejected promise

            // call 'before' hooks, modifying `context.args`
            const beforeMethodHooks = service?.hooks?.before && service.hooks.before[methodName] || []
            const beforeAllHooks = service?.hooks?.before?.all || []
            for (const hook of [...beforeMethodHooks, ...beforeAllHooks]) {
               context = await hook({ ...context, args })
            }

            // call method
            const result = await method(...context.args)
            // console.log('result', result)

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
   function addHttpRestRoutes(path, service) {

      const context = {
         app,
         transport: 'http',
      }

      app.post(path, async (req, res) => {
         const value = await service.__create(context, req.body)
         res.json(value)
      })

      app.get(path, async (req, res) => {
         const values = await service.__find(context, req.body)
         res.json(values)
      })

      app.get(`${path}/:id`, async (req, res) => {
         const value = await service.__get(context, parseInt(req.params.id))
         res.json(value)
      })

      app.patch(`${path}/:id`, async (req, res) => {
         const value = await service.__patch(context, parseInt(req.params.id), req.body)
         res.json(value)
      })

      app.delete(`${path}/:id`, async (req, res) => {
         const value = await service.__remove(context, parseInt(req.params.id))
         res.json(value)
      })
   }

   /*
    * Add websocket transport for services
    */
   const server = new http.Server(app)
   const io = new Server(server)
   
   io.on('connection', function(socket) {
      console.log('Client connected to the WebSocket')
      const connection = {
         id: lastConnectionId++,
         socket,
         channelNames: new Set(),
      }
      // store connection in cache 
      connections[connection.id] = connection

      // emit 'connection' event for app (expressjs extends EventEmitter)
      app.emit('connection', connection)

      // send 'connected' event to client
      socket.emit('connected', connection.id)

      socket.on('disconnect', () => {
         console.log('Client disconnected', connection.id)
         delete connections[connection.id]
      })


      /*
       * Handle websocket client request
       * Emit in return a 'client-response' message
       */
      socket.on('client-request', async ({ uid, name, action, args }) => {
         console.log("client-request", uid, name, action, args)
         if (name in services) {
            const service = services[name]
            try {
               const serviceMethod = service['__' + action]

               const context = {
                  app,
                  transport: 'ws',
                  connection,
                  name,
                  action,
               }
               const result = await serviceMethod(context, ...args)

               io.emit('client-response', {
                  uid,
                  result,
               })
               // pub/sub: send event on associated channels
               const publishFunc = service.publishCallback
               if (publishFunc) {
                  const channelNames = await publishFunc(result, app)
                  console.log('publish channels', name, action, channelNames)
                  for (const channelName of channelNames) {
                     console.log('service-event', name, action, channelName)
                     const connectionList = Object.values(connections).filter(cnx => cnx.channelNames.has(channelName))
                     for (const connection of connectionList) {
                        console.log('emit to', connection.id)
                        connection.socket.emit('service-event', {
                           name,
                           action,
                           result,
                        })
                     }
                  }
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

   function joinChannel(channelName, connection) {
      connection.channelNames.add(channelName)
   }

   function leaveChannel(channelName, connection) {
      connection.channelNames.delete(channelName)
   }

   // enhance `app` with objects and methods
   Object.assign(app, {
      createDatabaseService,
      createService,
      service,
      configure,
      addHttpRestRoutes,
      server,
      joinChannel,
      leaveChannel,
   })
   return app
}

export default expressX
