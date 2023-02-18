
const express = require('express')
const { PrismaClient } = require('@prisma/client')


function plume() {
   const app = express()
   const prisma = new PrismaClient()

   function createPrismaService(name) {
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

   return Object.assign(app, {
      createPrismaService,
      createCustomService,
      useREST,
   })
}

module.exports = plume
