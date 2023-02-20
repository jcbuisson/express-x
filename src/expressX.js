
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

   /*
    * create a service `name` based on Prisma table `name`
    */
   function createDatabaseService(name) {
      const service = {
         name,

         get: async (id) => {
            // ...before hooks
            const value = await prisma[name].findUnique({
               where: {
                 id,
               },
            })
            // ...after hook
            return value
         },

         find: async (query = {}) => {
            // ...before hooks
            const values = await prisma[name].findMany(query)
            // ...after hook
            return values
         },

         // pub/sub
         publish: async () => {
            return ['everyone']
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
   function useHTTP(path, service) {
      // console.log('path', path, 'service', service.name)

      app.get(path, async (req, res) => {
         const values = await service.find()
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

      socket.emit('hello', 'world')

      socket.on('disconnect', () => {
         console.log('Client disconnected')
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

   // enhance `app` with objects and methods
   Object.assign(app, {
      createDatabaseService,
      service,
      useHTTP,
      server,
      channels,
   })
}

module.exports = {
   enhanceExpress,
}
