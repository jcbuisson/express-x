
import expressX from '../src/index.mjs'
import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'

import { expect, assert } from 'chai'


// `app` is a regular express application, enhanced with express-x features
const app = expressX(express(), { debug: false })

app.createDatabaseService('User')
app.createDatabaseService('Post')



describe('ExpressX API', () => {

   it("can delete all users", async () => {
      const res = await app.service('User').deleteMany()
      console.log('res', res)
      assert('chris' === 'chris')
   })

   it("can create a user", async () => {
      const user = await app.service('User').create({
         data: {
            name: "chris",
            email: 'chris@mail.fr'
         },
      })
      assert(user.name === 'chris')
   })

   it("can find a user by name", async () => {
      const users = await app.service('User').findMany({
         where: {
            name: {
               startsWith: "chris"
            }
         }
      })
      assert(users.length > 0)
   })

   it("can find a unique user by email", async () => {
      const chris = await app.service('User').findUnique({
         where: {
            email: "chris@mail.fr"
         }
      })
      assert(chris.name === 'chris')
   })
})


describe('HTTP/REST API', () => {

   // add body parsers for http requests
   app.use(bodyParser.json())
   app.use(bodyParser.urlencoded({ extended: false }))

   // add http/rest endpoints
   app.addHttpRest('/api/user', app.service('User'))
   app.addHttpRest('/api/post', app.service('Post'))

   app.server.listen(8000, () => console.log(`App listening at http://localhost:8000`))

   let chris

   it("can create a user", async () => {
      const res = await axios.post('http://localhost:8000/api/user', {
         name: "carole",
         email: 'carole@mail.fr'
      })
      assert(res?.data?.name === 'carole')
   })

   it("can find users", async () => {
      const res = await axios.get('http://localhost:8000/api/user')
      assert(res?.data?.length > 0)
   })

   it("can find a user by name", async () => {
      const res = await axios.get('http://localhost:8000/api/user?name=chris')
      assert(res?.data?.length > 0)
      chris = res.data[0]
   })

   it("can find a user by id", async () => {
      const res = await axios.get(`http://localhost:8000/api/user/${chris.id}`)
      assert(res?.data?.id === chris.id)
   })

   it("can patch a user", async () => {
      const res = await axios.patch(`http://localhost:8000/api/user/${chris.id}`, {
         name: "Christiophe",
      })
      assert(res?.data?.name === "Christophe")
   })
})

process.exit(0)
