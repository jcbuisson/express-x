
import { io } from 'socket.io-client'
import { v4 } from 'uuid'

function expressxClient() {

   const socket = io()

   const waitingPromises = {}
   const createdHandlers = {}

   socket.on("hello", (arg) => {
      console.log(arg)

   })

   socket.on('create-response', ({ uid, error, value }) => {
      console.log('create-response', uid, error, value)
      const [resolve, reject] = waitingPromises[uid]
      if (error) {
         reject(error)
      } else {
         resolve(value)
      }
      delete waitingPromises[uid]
   })

   socket.on('find-response', ({ uid, error, values }) => {
      console.log('find-response', uid, error, values)
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

   socket.on('created', ({ name, value }) => {
      const handler = createdHandlers[name]
      handler(value)
   })

   function service(name) {
      return {
         create: (data) => {
            const uid = v4()
            const promise = new Promise((resolve, reject) => {
               waitingPromises[uid] = [resolve, reject]
            })
            socket.emit('create-request', {
               uid,
               name,
               data,
            })
            return promise
         },
         find: () => {
            const uid = v4()
            const promise = new Promise((resolve, reject) => {
               waitingPromises[uid] = [resolve, reject]
            })
            socket.emit('find-request', {
               uid,
               name,
            })
            return promise
         },

         on: (eventName, handler) => {
            if (eventName === 'created') {
               createdHandlers[name] = handler
            }
         }
      }
   }

   return {
      service,
      socket,
   }
}

export default expressxClient
