
import { io } from 'socket.io-client'
import { v4 } from 'uuid'

function expressxClient() {

   const socket = io()

   const waitingPromises = {}
   const action2service2handlers = {}

   // on connection
   socket.on("hello", async (arg) => {
      console.log(arg)
      const token = window.sessionStorage.getItem('feathers-jwt')
      if (token) {
         // disconnect/reconnect: reauthenticate
         console.log('reauthenticate with', token)
         serviceMethodRequest('authenticate', 'patch', [token])
      }
   })

   // on receiving response from service request
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

   // on receiving events from pub/sub
   socket.on('service-event', ({ name, action, result }) => {
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) handler(result)
   })

   async function serviceMethodRequest(name, action, argList) {
      console.log('argList', argList)
      const uid = v4()
      const promise = new Promise((resolve, reject) => {
         waitingPromises[uid] = [resolve, reject]
      })
      socket.emit('client-request', {
         uid,
         name,
         action,
         argList,
      })
      return promise
   }

   function service(name) {
      return {
         // create: (data) => {
         //    const uid = v4()
         //    const promise = new Promise((resolve, reject) => {
         //       waitingPromises[uid] = [resolve, reject]
         //    })
         //    socket.emit('client-request', {
         //       uid,
         //       name,
         //       action: 'create',
         //       ...data,
         //    })
         //    return promise
         // },
         // find: () => {
         //    const uid = v4()
         //    const promise = new Promise((resolve, reject) => {
         //       waitingPromises[uid] = [resolve, reject]
         //    })
         //    socket.emit('client-request', {
         //       uid,
         //       name,
         //       action: 'find',
         //    })
         //    return promise
         // },
         create: (data) => serviceMethodRequest(name, 'create', [data]),
         get: (id) => serviceMethodRequest(name, 'create', [id]),
         patch: (id, data) => serviceMethodRequest(name, 'create', [id, data]),
         find: (data) => serviceMethodRequest(name, 'find', [data]),

         // associate a handler to a pub/sub event for this service
         on: (action, handler) => {
            if (!action2service2handlers[action]) action2service2handlers[action] = {}
            const serviceHandlers = action2service2handlers[action]
            serviceHandlers[name] = handler
            console.log('action2service2handlers', action2service2handlers)
         },
      }
   }

   return {
      service,
      socket,
   }
}

export default expressxClient
