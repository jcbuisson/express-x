
import { io } from 'socket.io-client'
import { v4 } from 'uuid'

function expressxClient() {

   const socket = io()

   const waitingPromises = {}
   const action2service2handlers = {}

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

   socket.on('service-event', ({ name, action, result }) => {
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) handler(result)
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

         // add handler to service event
         on: (action, handler) => {
            if (!action2service2handlers[action]) action2service2handlers[action] = {}
            const serviceHandlers = action2service2handlers[action]
            serviceHandlers[name] = handler
            console.log('action2service2handlers', action2service2handlers)
         },
      }
   }

   // function authenticate({ strategy, username, password }) {
   //    console.log("authenticate", username, password)
   //    const uid = v4()
   //    const promise = new Promise((resolve, reject) => {
   //       waitingPromises[uid] = [resolve, reject]
   //    })
   //    socket.emit('authenticate-request', {
   //       uid,
   //       strategy, username, password,
   //    })
   //    return promise
   // }

   return {
      service,
      socket,
      // authenticate,
   }
}

export default expressxClient
