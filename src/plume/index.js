
const express = require('express')
// const http = require('http')
// const socketio = require('socket.io')

// const { createDatabaseService } = require('./databaseService')
const { PrismaClient } = require('@prisma/client')


function plume() {
   const app = express()
   const prisma = new PrismaClient()

   function createDatabaseService(name) {
      return {
         name,
   
         create: async (data) => {
            const value = await prisma[name].create({
               data,
            })
            return value
         },
   
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
   
   function createCustomService(name) {
      return {
         name,

         create: async (data) => {
            console.log(name, data)
         }
      }
   }

   function useREST(path, service) {
      // console.log('path', path, 'service', service.name)

      app.get(path, async (req, res) => {
         const values = await service.find()
         res.json(values)
      })
   }

   // const server = new http.Server(app)
   // const io = new socketio.Server(server)
   
   
   // io.on('connection', function(socket) {
   //    console.log('Client connected to the WebSocket')

   //    socket.on('disconnect', () => {
   //       console.log('Client disconnected')
   //    })

   //    socket.on('chat message', function(msg) {
   //       console.log("Received a chat message")
   //       io.emit('chat message', msg)
   //    })
   // })

   return Object.assign(app, {
      createDatabaseService,
      createCustomService,
      useREST,
   })
}

module.exports = plume
