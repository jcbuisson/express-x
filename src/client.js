// uuidv7 are monotonically increasing and much improve database performance amid B-tree indexes
import { v7 as uuidv7 } from 'uuid';
import { tryOnScopeDispose } from '@vueuse/core';
import { useSessionStorage } from '@vueuse/core'


//////////////////////////       EXPRESSX       //////////////////////////

export function createClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const action2service2handlers = new Map()
   const type2appHandler = new Map()
   let connectListeners = []
   let disconnectListeners = []
   let errorListeners = []

   function configure(callback, ...args) {
      callback(app, ...args)
   }

   socket.on("connect", async () => {
      if (options.debug) console.log("socket connected", socket.id)
      for (const func of connectListeners) {
         try {
            await func(socket)
         } catch(err) {
            console.error('connect listener error', err)
         }
      }
   })

   socket.on("connect_error", async (err) => {
      if (options.debug) console.log("socket connection error", socket.id)
      for (const func of errorListeners) {
         func(socket)
      }
   })

   socket.on("disconnect", async () => {
      if (options.debug) console.log("socket disconnected", socket.id)
      for (const func of disconnectListeners) {
         func(socket)
      }
   })

   function addConnectListener(func) {
      connectListeners.push(func)
   }
   function removeConnectListener(func) {
      connectListeners = connectListeners.filter(f => f !== func)
   }

   function addDisconnectListener(func) {
      disconnectListeners.push(func)
   }
   function removeDisconnectListener(func) {
      disconnectListeners = disconnectListeners.filter(f => f !== func)
   }

   function addErrorListener(func) {
      errorListeners.push(func)
   }
   function removeErrorListener(func) {
      errorListeners = errorListeners.filter(f => f !== func)
   }

   // on receiving service events from pub/sub
   socket.on('service-event', (event) => {
      if (!event || typeof event !== 'object'
         || typeof event.name !== 'string'
         || typeof event.action !== 'string') return
      const { name, action, result } = event
      if (options.debug) console.log('service-event', name, action, result)
      const handlers = action2service2handlers.get(action)?.get(name)
      if (!handlers) return
      for (const handler of handlers) {
         Promise.resolve(handler(result)).catch(err => console.error('service-event handler error', name, action, err))
      }
   })
   
   async function serviceMethodRequest(name, action, serviceOptions, ...args) {
      if (options.debug) console.log('client-request', name, action, args)
      // use socket.io acknowledgment for request/response correlation
      const emitter = serviceOptions.volatile
         ? socket.volatile
         : socket.timeout(serviceOptions.timeout || 20000)
      const { error, result } = await emitter.emitWithAck('client-request', { name, action, args })
      if (error) throw error
      return result
   }

   function service(name, serviceOptions={}) {
      if (serviceOptions.timeout === undefined) serviceOptions.timeout = 20000
      const service = {
         // associate a handler to a pub/sub event for this service
         on: (action, handler) => {
            if (!action2service2handlers.has(action)) action2service2handlers.set(action, new Map())
            const serviceHandlers = action2service2handlers.get(action)
            if (!serviceHandlers.has(name)) serviceHandlers.set(name, new Set())
            const handlers = serviceHandlers.get(name)
            handlers.add(handler)
            return () => {
               handlers.delete(handler)
               if (handlers.size === 0) serviceHandlers.delete(name)
               if (serviceHandlers.size === 0) action2service2handlers.delete(action)
            }
         },
         call: (action, ...args) => serviceMethodRequest(name, action, serviceOptions, ...args),
      }
      // use a Proxy to allow for any method name for a service
      const handler = {
         get(service, action) {
            if (action === 'then') return undefined
            if (typeof action !== 'string') return Reflect.get(service, action)
            if (!Object.hasOwn(service, action)) {
               // newly used property `action`: define it as a service method request function
               service[action] = (...args) => serviceMethodRequest(name, action, serviceOptions, ...args)
            }
            return service[action]
         }
      }
      return new Proxy(service, handler)
   }

   //--------------------         APPLICATION-LEVEL EVENTS         --------------------

   // There is a need for application-wide events sent outside any service method call, for example when backend state changes
   // without front-end interactions
   socket.on('app-event', (event) => {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
      const { type, value } = event
      if (options.debug) console.log('app-event', type, value)
      const handler = type2appHandler.get(type)
      if (typeof handler === 'function') handler(value)
   })

   // add a handler for application-wide events
   function on(type, handler) {
      type2appHandler.set(type, handler)
   }

   const app = {
      configure,
      addConnectListener,
      removeConnectListener,
      addDisconnectListener,
      removeDisconnectListener,
      addErrorListener,
      removeErrorListener,
   
      service,
      on,
   }

   return app
}
