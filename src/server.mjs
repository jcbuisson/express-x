import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'



//////////////////////////       UTILITIES       //////////////////////////

export function truncateString(str, maxLength = 300, ellipsis = '...') {
   // Check if the string already fits
   if (str.length <= maxLength) return str;
   // Calculate the cut-off point, accounting for the ellipsis length
   const cutLength = maxLength - ellipsis.length;
   // Ensure the string is long enough to be cut
   if (cutLength < 0) return str.substring(0, maxLength); // Just cut it off if ellipsis doesn't fit
   // Truncate the string and add the ellipsis
   return str.substring(0, cutLength) + ellipsis;
}


export class Mutex {
   constructor() {
      this.locked = false;
      this.queue = [];
   }

   async acquire() {
      if (this.locked) {
         return new Promise(resolve => this.queue.push(resolve));
      }
      this.locked = true;
   }

   release() {
      if (this.queue.length > 0) {
         const next = this.queue.shift();
         next();
      } else {
         this.locked = false;
      }
   }
}

//////////////////////////       EXPRESSX       //////////////////////////

export function expressX(config) {

   const services = new Map()
   const socketConnectListeners = []
   const socketDisconnectingListeners = []
   const socketDisconnectListeners = []


   function addConnectListener(func) {
      socketConnectListeners.push(func)
   }

   function addDisconnectingListener(func) {
      socketDisconnectingListeners.push(func)
   }

   function addDisconnectListener(func) {
      socketDisconnectListeners.push(func)
   }

   const app = express()
   const httpServer = createServer(app)

   // so that config can be accessed anywhere with app.get('config')
   app.set('config', config)

   const io = new Server(httpServer, {
      path: config?.WS_PATH || '/socket.io/',
      connectionStateRecovery: {
         // the backup duration of the sessions and the packets
         maxDisconnectionDuration: config?.maxDisconnectionDuration ?? 2 * 60 * 1000,
         // whether to skip middlewares upon successful recovery
         skipMiddlewares: config?.skipRecoveryMiddlewares ?? false,
      }
   })

   // so that io server is accessible to hooks & services
   app.set('io', io)

   // logging function - a winston logger must be configured first
   app.log = (severity, message) => {
      const logger = app.get('logger')
      if (logger) logger.log(severity, message); else console.log(`[${severity}]`, message)
   }

   io.on('connection', async function(socket) {
      if (socket.recovered) {
         // recovery was successful: socket.id, socket.rooms and socket.data were restored
         // (network/Wifi disconnections)
         console.log('reconnection!!!', socket.id, socket.data)
      } else {
         // new or unrecoverable connection
         // (page open, page refresh/reload)
      }

      app.log('verbose', `Client connected ${socket.id}`)

      // emit 'connection' event for app (expressjs extends EventEmitter)
      app.emit('connection', socket)

      socketConnectListeners.forEach(listener => listener(socket))

      // send 'connected' event to client
      socket.emit('connected', socket.id)

      socket.on('disconnecting', (reason) => {
         app.log('verbose', `Client disconnecting ${socket.id}, ${reason}`)
         socketDisconnectingListeners.forEach(listener => listener(socket, reason))
      })

      socket.on('disconnect', (reason) => {
         app.log('verbose', `Client disconnect ${socket.id}, ${reason}`)
         socketDisconnectListeners.forEach(listener => listener(socket, reason))
      })

      /*
      * Handle websocket client request
      * Respond via socket.io acknowledgment callback
      */
      socket.on('client-request', async (request, ack) => {
         const respond = (payload) => {
            if (typeof ack === 'function') ack(payload)
            else app.log('verbose', 'client-request missing acknowledgment callback')
         }
         if (!request || typeof request !== 'object'
            || typeof request.name !== 'string'
            || typeof request.action !== 'string'
            || !Array.isArray(request.args)) {
            respond({ error: { code: 'invalid-request', message: 'invalid client request envelope' } })
            return
         }
         const { name, action, args } = request
         const trimmedArgs = args ? JSON.stringify(args).slice(0, 300) : ''
         app.log('verbose', `client-request ${name} ${action} ${trimmedArgs}`)

         if (services.has(name)) {
            const service = services.get(name)
            try {
               const serviceMethod = service['__' + action]
               if (serviceMethod) {
                  const context = {
                     app,
                     caller: 'client',
                     origin: null,
                     transport: 'ws',
                     socket,
                     serviceName: name,
                     methodName: action,
                     args,
                  }
                  context.origin = context

                  try {
                     const result = await serviceMethod(context, ...args)

                     const trimmedResult = result ? JSON.stringify(result).slice(0, 300) : ''
                     app.log('verbose', `client-response ${trimmedResult}`)
                     respond({ result })
                  } catch(err) {
                     console.log('!!!!!!error', 'name', name, 'action', action, 'args', args, 'err.code', err.code, 'err.message', err.message)
                     app.log('verbose', err.stack)
                     respond({
                        error: {
                           code: err.code || 'unknown-error',
                           message: err.message,
                           stack: err.stack,
                        }
                     })
                  }
               } else {
                  respond({
                     error: {
                        code: 'missing-method',
                        message: `there is no method named '${action}' for service '${name}'`,
                     }
                  })
               }
            } catch(err) {
               console.log('err', err)
               app.log('verbose', err.stack)
               respond({
                  error: {
                     code: err.code || 'unknown-error',
                     message: err.message,
                     stack: err.stack,
                  }
               })
            }
         } else {
            respond({
               error: {
                  code: 'missing-service',
                  message: `there is no service named '${name}'`,
               }
            })
         }
      })

   })

   /*
    * create a service `name` with given `methods`
    */
   function createService(name, methods) {
      if (typeof name !== 'string' || !name) throw new TypeError('service name must be a non-empty string')
      if (services.has(name)) throw new EXError('duplicate-service', `service '${name}' already exists`)
      const service = Object.assign(Object.create(null), { _name: name })

      for (const [methodName, method] of Object.entries(methods ?? {})) {
         if (!(method instanceof Function)) continue

         // `context` is the context of execution (transport type, connection, app)
         // `args` is the list of arguments of the method
         service['__' + methodName] = async (context, ...args) => {
            // put args into context
            context.args = args

            // if a hook or the method throws an error, it will be caught by `socket.on('client-request'`
            // and the client will get a rejected promise

            // call 'before' hooks, possibly modifying `context`
            const beforeMethodHooks = service?._hooks?.before && service._hooks.before[methodName] || []
            const beforeAllHooks = service?._hooks?.before?.all || []
            for (const hook of [...beforeAllHooks, ...beforeMethodHooks]) {
               await hook(context)
            }

            // call method — use context.args so before-hooks can modify arguments
            const result = await method.apply(context, context.args)
            // put result into context
            context.result = result

            // call 'after' hooks, possibly modifying `context`
            const afterMethodHooks = service?._hooks?.after && service._hooks.after[methodName] || []
            const afterAllHooks = service?._hooks?.after?.all || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks]) {
               await hook(context)
            }

            // publish 'service-event' event associated to service/method
            if (service.publishFunction) {
               // collect channel names to socket is member of
               const channelNames = await service.publishFunction(context)
               // send event on all these channels
               if (Array.isArray(channelNames) && channelNames.length > 0) {
                  app.log('verbose', `publish channels ${name} ${methodName} ${channelNames}`)
                  let sender = io.to(channelNames[0])
                  for (let i = 1; i < channelNames.length; i++) {
                     sender = sender.to(channelNames[i])
                  }
                  sender.emit('service-event', {
                     name,
                     action: methodName,
                     result,
                  })
               }
            }
            
            return context.result
         }

         // hooked version of method to be used server-side
         service[methodName] = (...args) => {
            const context = {
               app,
               caller: 'server',
               serviceName: service._name,
               methodName,
               args,
            }
            context.origin = context
            const hookedMethod = service['__' + methodName]
            return hookedMethod(context, ...args)
         }
      }

      service.callWithContext = (parentContext, methodName, ...args) => {
         const hookedMethod = service['__' + methodName]
         if (!hookedMethod) throw new EXError('missing-method', `there is no method named '${methodName}' for service '${name}'`)
         const context = {
            app,
            caller: 'server',
            origin: parentContext?.origin ?? parentContext,
            serviceName: service._name,
            methodName,
            args,
         }
         return hookedMethod(context, ...args)
      }

      // attach pub/sub publish callback
      service.publish = async (func) => {
         service.publishFunction = func
      },

      // attach hooks
      service.hooks = (hooks) => {
         service._hooks = hooks
      }

      // cache service in `services`
      services.set(name, service)
      return service
   }

   function configure(callback, ...args) {
      callback(app, ...args)
   }

   // `app.service(name)` starts here!
   function service(name) {
      // get service from `services` cache
      if (services.has(name)) return services.get(name)
      throw new EXError('missing-service', `there is no service named '${name}'`)
   }

   function joinChannel(channelName, socket) {
      app.log('verbose', `joining ${channelName}, ${JSON.stringify(socket.data)}`)
      socket.join(channelName)
   }

   function leaveChannel(channelName, socket) {
      app.log('verbose', `leaving ${channelName}, ${JSON.stringify(socket.data)}`)
      socket.leave(channelName)
   }

   // There is a need for events sent outside any service method call, for example on unsolicited-by-frontend backend state change
   async function sendAppEvent(channelName, type, value) {
      console.log('sendAppEvent', channelName, type, value)
      io.to(channelName).emit('app-event', { type, value })
   }

   // enhance `app` with objects and methods
   return Object.assign(app, {
      io,
      httpServer,
      createService,
      service,
      configure,
      joinChannel,
      leaveChannel,
      sendAppEvent,
      addConnectListener,
      addDisconnectingListener,
      addDisconnectListener,
   })
}

export class EXError extends Error {
   constructor(code, message) {
      super(message)
      this.code = code
   }
}


//////////////////////////       COMMON HOOK METHODS       //////////////////////////

/*
 * Add a timestamp property of name `field` with current time as value
*/
export const addTimestamp = (field) => async (context) => {
   if (context.result != null) context.result[field] = (new Date()).toISOString()
}

/*
 * Hash password of the property `field`
*/
export const hashPassword = (passwordField) => async (context) => {
   for (const arg of (context.args || [])) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg) && passwordField in arg) {
         arg[passwordField] = await bcrypt.hash(arg[passwordField], 5)
         return
      }
   }
}

/*
 * Remove `field` from `context.result`
*/
export const protect = (field) => (context) => {
   if (context.result) {
      if (Array.isArray(context.result)) {
         for (const value of context.result) {
            delete value[field]
         }
      } else if (typeof context.result === "object") {
         delete context.result[field]
      }
   }
}
