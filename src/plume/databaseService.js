
const { PrismaClient } = require('@prisma/client')

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

module.exports = {
   createDatabaseService,
}
