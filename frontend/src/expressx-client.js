
import { io } from 'socket.io-client'
import { v4 } from 'uuid'

function expressxClient() {

   const socket = io()

   const waitingPromises = {}
   const createdHandlers = {}

   socket.on("hello", (arg) => {
      console.log(arg)

   })

   socket.on('client-response', ({ uid, error, result }) => {
      console.log('client-response', uid, error, result)
      const [resolve, reject] = waitingPromises[uid]
      if (error) {
         reject(error)
      } else {
         resolve(result)
      }
      delete waitingPromises[uid]
   })

   socket.on('authenticate-response', ({ uid, error, user }) => {
      console.log('authenticate-response', uid, error, user)
      const [resolve, reject] = waitingPromises[uid]
      if (error) {
         reject(error)
      } else {
         resolve(values)
      }
      delete waitingPromises[uid]
   })

   socket.on('error-xxx', ({ uid, error }) => {
      console.log('error-xxx', uid, error)
   })

   socket.on('create-ed', ({ name, result }) => {
      const handler = createdHandlers[name]
      handler(result)
   })

   function service(name) {
      return {
         create: (data) => {
            const uid = v4()
            const promise = new Promise((resolve, reject) => {
               waitingPromises[uid] = [resolve, reject]
            })
            socket.emit('client-request', {
               uid,
               name,
               action: 'create',
               ...data,
            })
            return promise
         },
         find: () => {
            const uid = v4()
            const promise = new Promise((resolve, reject) => {
               waitingPromises[uid] = [resolve, reject]
            })
            socket.emit('client-request', {
               uid,
               name,
               action: 'find',
            })
            return promise
         },

         on: (eventName, handler) => {
            if (eventName === 'created') {
               createdHandlers[name] = handler
            }
         },
      }
   }

   function authenticate({ strategy, username, password }) {
      console.log("authenticate", username, password)
      const uid = v4()
      const promise = new Promise((resolve, reject) => {
         waitingPromises[uid] = [resolve, reject]
      })
      socket.emit('authenticate-request', {
         uid,
         strategy, username, password,
      })
      return promise
   }

   return {
      service,
      socket,
      authenticate,
   }
}

export default expressxClient
