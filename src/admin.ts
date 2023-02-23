import express from 'express'
import AdminJS from 'adminjs'
import AdminJSExpress from '@adminjs/express'
import { Database, Resource } from '@adminjs/prisma'
import { PrismaClient } from '@prisma/client'
import { DMMFClass } from '@prisma/client/runtime'

const PORT = process.env.port || 3020

const prisma = new PrismaClient()

AdminJS.registerAdapter({ Database, Resource })

const run = async () => {
  const app = express()

  // `_baseDmmf` contains necessary Model metadata. `PrismaClient` type doesn't have it included
  const dmmf = ((prisma as any)._baseDmmf as DMMFClass)

  const admin = new AdminJS({
    resources: [{
      resource: { model: dmmf.modelMap.Post, client: prisma },
      options: {},
    }, {
      resource: { model: dmmf.modelMap.User, client: prisma },
      options: {},
    }],
  })

  const router = AdminJSExpress.buildRouter(admin)

  app.use(admin.options.rootPath, router)

  app.listen(PORT, () => {
    console.log(`Example app listening at http://localhost:${PORT}`)
  })
}

run()
  .finally(async () => {
    await prisma.$disconnect()
  })