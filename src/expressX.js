
const express = require('express')
const http = require('http')
const socketio = require('socket.io')

const { PrismaClient } = require('@prisma/client')


function expressX() {
   const app = express()
   const prisma = new PrismaClient()

   function createDatabaseService(name) {
      return {
         name,

         get: async (id) => {
            const value = await prisma[name].findUnique({
               where: {
                 id,
               },
            })
            return value
         },

         find: async (query = {}) => {
            const values = await prisma[name].findMany(query)
            return values
         }
      }
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

      socket.on('chat message', function(msg) {
         console.log("Received a chat message")
         io.emit('chat message', msg)
      })
   })

   return Object.assign(app, {
      createDatabaseService,
      useHTTP,
      server,
   })
}

module.exports = expressX
