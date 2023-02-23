
const http = require('http')
const socketio = require('socket.io')
const config = require('config')

const { PrismaClient } = require('@prisma/client')

/*
 * Enhance `app` express application with Feathers-like services
 */
function enhanceExpress(app) {
   const prisma = new PrismaClient()
   app.set('prisma', prisma) // ?? BOF

   const services = {}
   const publishCallbacks = {}
   const connections = {}

   let lastConnectionId = 1

   /*
    * create a service `name` based on Prisma table `entity`
    */
   function createDatabaseService({ name, entity=name, client='prisma' }) {
      const service = {
         name,
         entity,

         create: async (data) => {
            // TODO...before hooks
            const value = await prisma[entity].create({ data })
            // TODO...after hook
            return value
         },

         get: async (id) => {
            // TODO...before hooks
            const value = await prisma[entity].findUnique({
               where: {
                 id,
               },
            })
            // TODO...after hook
            return value
         },

         find: async (query = {}) => {
            // ...before hooks
            const values = await prisma[entity].findMany(query)
            // ...after hook
            return values
         },

         // pub/sub
         publish: async (func) => {
            publishCallbacks[name] = func
         },
      }
      // cache service in `services`
      services[name] = service
      return service
   }

   /*
    * create a custom service `name`
    */
   function createCustomService({ name, create, get, find, patch, update, remove }) {
      const service = {
         name,

         create: async (data) => {
            // TODO...before hooks
            const value = await create(data)
            // TODO...after hook
            return value
         },

         // pub/sub
         publish: async (func) => {
            publishCallbacks[name] = func
         },
      }
      // cache service in `services`
      services[name] = service
      return service
   }

   // get service from `services` cache
   function service(name) {
      if (name in services) return services[name]
      throw Error(`there is no service named '${name}'`)
   }

   function configure(callback) {
      callback(app)
   }

   /*
    * provide a REST endpoint at `path`, based on `service`
    */
   function httpRestService(path, service) {
      // console.log('path', path, 'service', service.name)

      app.post(path, async (req, res) => {
         const value = await service.create(req.body)
         res.json(value)
      })

      app.get(path, async (req, res) => {
         const values = await service.find({
            where: req.body,
         })
         res.json(values)
      })

      app.get(`${path}/:id`, async (req, res) => {
         const value = await service.get(parseInt(req.params.id))
         res.json(value)
      })
   }

   /*
    * Add websocket transport for services
    */
   const server = new http.Server(app)
   const io = new socketio.Server(server)
   
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

      socket.emit('hello', 'world')

      socket.on('disconnect', () => {
         console.log('Client disconnected', connection.id)
         delete connections[connection.id]
      })


      /*
       * Handle websocket client request
       * Emit in return a 'client-response' message
       */
      socket.on('client-request', async ({ uid, name, action, ...args }) => {
         console.log("client-request", uid, name, action, args)
         if (name in services) {
            const service = services[name]
            try {
               const serviceMethod = service[action]
               const result = await serviceMethod(args)
               console.log('result', result)
               io.emit('client-response', {
                  uid,
                  result,
               })
               // send event on associated channels
               const publishFunc = publishCallbacks[name]
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
               console.log('error', error)
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

   // enhance `app` with objects and methods
   Object.assign(app, {
      createDatabaseService,
      createCustomService,
      service,
      configure,
      httpRestService,
      server,
      joinChannel,
   })
}

module.exports = {
   enhanceExpress,
}
