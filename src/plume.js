
const express = require('express')
const { PrismaClient } = require('@prisma/client')


function plume() {
   const app = express()
   const prisma = new PrismaClient()

   function service(name) {
      return {
         find: async () => {
            const values = await prisma.user.findMany()
            return values
         }
      }
   }

   function useX(path, name, service) {
      console.log('path', path, 'name', name, 'service', service)

      app.get('/users', async (req, res) => {
         const service = app.service('user')
         const values = await service.find()
         res.json(values)
      })
   }

   return Object.assign(app, {
      service,
      useX,
   })
}

module.exports = plume
