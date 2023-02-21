
const http = require('http')
const socketio = require('socket.io')

const { PrismaClient } = require('@prisma/client')

/*
 * Enhance `app` express application with Feathers-like services
 */
function enhanceExpress(app) {
   const prisma = new PrismaClient()

   const channels = []
   const services = {}
   const publishes = {}

   let connectionId = 1

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
            publishes[name] = func
         },
      }
      // cache service in `services`
      services[name] = service
      return service
   }

   /*
    * create a custom service `name`
    */
   function createCustomService({ name, create, patch, update, remove }) {
      const service = {
         name,

         create: async (data) => {
            // TODO...before hooks
            const value = await create(data)
            // TODO...after hook
            return value
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
         id: connectionId++,
         socket,
      }
      // expressjs extends EventEmitter
      app.emit('connection', connection)

      socket.emit('hello', 'world')

      socket.on('disconnect', () => {
         console.log('Client disconnected')
      })

      // handle websocket 'create' request
      socket.on('create-request', async ({ uid, name, data }) => {
         console.log("create-request", uid, name)
         if (name in services) {
            const service = services[name]
            try {
               const value = await service.create(data)
               io.emit('create-response', {
                  uid,
                  value,
               })
               // send 'created' event on associated channels
               const publishFunc = publishes[name]
               console.log('publishFunc', publishFunc)
               if (publishFunc) {
                  const channelNames = await publishFunc(value, app)
                  console.log('publish channels', channelNames)
                  for (const channelName of channelNames) {
                     for (const connection of channels[channelName]) {
                        connection.socket.emit('created', {
                           name,
                           value,
                        })
                     }
                  }
               }
            } catch(error) {
               io.emit('error-xxx', {
                  uid,
                  error,
               })
            }
         } else {
            io.emit('create-response', {
               uid,
               error: `there is no service named '${name}'`,
            })
         }
      })

      // handle websocket 'find' request
      socket.on('find-request', async ({ uid, name, query={} }) => {
         console.log("find-request", uid, name)
         if (name in services) {
            const service = services[name]
            try {
               const values = await service.find(query)
               io.emit('find-response', {
                  uid,
                  values,
               })
            } catch(error) {
               io.emit('find-response', {
                  uid,
                  error,
               })
            }
         } else {
            io.emit('find-response', {
               uid,
               error: `there is no service named '${name}'`,
            })
         }
      })
   })

   function joinChannel(channelName, connection) {
      const connectionList = channels[channelName]
      if (connectionList) {
         connectionList.push(connection)
      } else {
         channels[channelName] = [connection]
      }
   }

   // enhance `app` with objects and methods
   Object.assign(app, {
      createDatabaseService,
      createCustomService,
      service,
      httpRestService,
      server,
      joinChannel,
   })
}

module.exports = {
   enhanceExpress,
}
