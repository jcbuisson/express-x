
import { v4 } from 'uuid'

export function expressXClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const waitingPromisesByUid = {}
   const action2service2handlers = {}
   let onConnectionCallback = null
   let onDisconnectionCallback = null

   const setConnectionCallback = (callback) => {
      onConnectionCallback = callback
   }

   const setDisconnectionCallback = (callback) => {
      onDisconnectionCallback = callback
   }

   // on connection
   socket.on("connected", async (connectionId) => {
      if (options.logger) options.logger.log('info', 'connected', connectionId)
      if (onConnectionCallback) onConnectionCallback(connectionId)
   })

   // on receiving response from service request
   socket.on('client-response', ({ uid, error, result }) => {
      if (options.logger) options.logger.log('info', 'client-response', uid, error, result)
      if (!waitingPromisesByUid[uid]) return // may not exist because a timeout removed it
      const [resolve, reject] = waitingPromisesByUid[uid]
      if (error) {
         reject(error)
      } else {
         resolve(result)
      }
      delete waitingPromisesByUid[uid]
   })

   // on receiving events from pub/sub
   socket.on('service-event', ({ name, action, result }) => {
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) handler(result)
   })

   async function serviceMethodRequest(name, action, ...args) {
      const uid = v4()
      // create a promise which will resolve or reject by an event 'client-response'
      const promise = new Promise((resolve, reject) => {
         waitingPromisesByUid[uid] = [resolve, reject]
         // a 5s timeout may also reject the promise
         setTimeout(() => {
            delete waitingPromisesByUid[uid]
            reject(`Error: timeout on service '${name}', action '${action}', args: ${args}`)
         }, 5000)
      })
      // send request to server through websocket
      socket.emit('client-request', {
         uid,
         name,
         action,
         args,
      })
      return promise
   }

   function service(name) {
      const service = {
         // associate a handler to a pub/sub event for this service
         on: (action, handler) => {
            if (!action2service2handlers[action]) action2service2handlers[action] = {}
            const serviceHandlers = action2service2handlers[action]
            serviceHandlers[name] = handler
         },
      }
      // use a Proxy to allow for any method name for a service
      const handler = {
         get(service, action) {
            if (!(action in service)) {
               // newly used property `action`: define it as a service method request function
               service[action] = (...args) => serviceMethodRequest(name, action, ...args)
            }
            return service[action]
         }
      }
      return new Proxy(service, handler)
   }

   return {
      setConnectionCallback,
      setDisconnectionCallback,
      service,
   }
}
