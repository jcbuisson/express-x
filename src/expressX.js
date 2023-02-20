
const express = require('express')
const http = require('http')
const socketio = require('socket.io')

const { PrismaClient } = require('@prisma/client')


function expressX() {
   const app = express()
   const prisma = new PrismaClient()

   app.use(express.urlencoded({ extended: true }))
   app.use(express.json())


   const channels = []
   const services = {}

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
      services[name] = service
      return service
   }

   function service(name) {
      if (name in services) return services[name]
      throw Error(`there is no service named '${name}'`)
   }

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


   const server = new http.Server(app)
   const io = new socketio.Server(server)
   
   io.on('connection', function(socket) {
      console.log('Client connected to the WebSocket')

      socket.emit('hello', 'world')

      socket.on('disconnect', () => {
         console.log('Client disconnected')
      })

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

   return Object.assign(app, {
      createDatabaseService,
      service,
      useHTTP,
      server,
      channels,
   })
}

module.exports = expressX
