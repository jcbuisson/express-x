import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"


export function expressX(config) {

   const services = {}
   let appHooks = []

   const app = express()
   const httpServer = createServer(app)

   // so that config can be accessed anywhere with app.get('config')
   app.set('config', config)

   const io = new Server(httpServer, {
      path: config?.WS_PATH || '/socket.io/',
      connectionStateRecovery: {
         // the backup duration of the sessions and the packets
         maxDisconnectionDuration: 2 * 60 * 1000,
         // whether to skip middlewares upon successful recovery
         skipMiddlewares: true,
      }
   })

   // logging function - a winston logger must be configured first
   app.log = (severity, message) => {
      const logger = app.get('logger')
      if (logger) logger.log(severity, message); else console.log(`[${severity}]`, message)
   }

   io.on('connection', async function(socket) {
      if (socket.recovered) {
         // recovery was successful: socket.id, socket.rooms and socket.data were restored
         console.log('reconnection!!!', socket.id)

      } else {
         // new or unrecoverable session
         console.log("connection", socket.id)
      }

      const clientIP = socket.handshake.address
      socket.data = {
         clientIP,
      }
      // app.log('verbose', `Client connected ${connectionId} from IP ${clientIP}`)
      app.log('verbose', `Client connected ${socket.id} from IP ${clientIP}`)

      // emit 'connection' event for app (expressjs extends EventEmitter)
      app.emit('connection', socket)

      // send 'connected' event to client
      // socket.emit('connected', connectionId)
      socket.emit('connected', socket.id)

      socket.on('disconnect', () => {
         // app.log('verbose', `Client disconnected ${connectionId}`)
         app.log('verbose', `Client disconnected ${socket.id}`)
      })

      /*
      * Handle websocket client request
      * Emit in return a 'client-response' message
      */
      socket.on('client-request', async ({ uid, name, action, args }) => {
         const trimmedArgs = args ? JSON.stringify(args).slice(0, 300) : ''
         app.log('verbose', `client-request ${uid} ${name} ${action} ${trimmedArgs}`)
         if (name in services) {
            const service = services[name]
            try {
               const serviceMethod = service['__' + action]
               if (serviceMethod) {
                  const context = {
                     app,
                     caller: 'client',
                     transport: 'ws',
                     socket,
                     // connectionId,
                     serviceName: name,
                     methodName: action,
                     args,
                  }

                  try {
                     // call method with context
                     const result = await serviceMethod(context, ...args)

                     const trimmedResult = result ? JSON.stringify(result).slice(0, 300) : ''
                     app.log('verbose', `client-response ${uid} ${trimmedResult}`)
                     socket.emit('client-response', {
                        uid,
                        result,
                     })
                  } catch(err) {
                     console.log('!!!!!!error', err.code, err)
                     app.log('verbose', err.stack)
                     socket.emit('client-response', {
                        uid,
                        error: {
                           code: err.code || 'unknown-error',
                           message: err.stack,
                        }
                     })
                  }
               } else {
                  socket.emit('client-response', {
                     uid,
                     error: {
                        code: 'missing-method',
                        message: `there is no method named '${action}' for service '${name}'`,
                     }
                  })
               }
            } catch(err) {
               console.log('err', err)
               app.log('verbose', err.stack)
               socket.emit('client-response', {
                  uid,
                  error: {
                     code: err.code || 'unknown-error',
                     message: err.stack,
                  }
               })
            }
         } else {
            socket.emit('client-response', {
               uid,
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
      const service = { name }

      for (const methodName in methods) {
         const method = methods[methodName]
         if (! method instanceof Function) continue

         // `context` is the context of execution (transport type, connection, app)
         // `args` is the list of arguments of the method
         service['__' + methodName] = async (context, ...args) => {
            // put args into context
            context.args = args

            // if a hook or the method throws an error, it will be caught by `socket.on('client-request'` (ws)
            // or by express (http) and the client will get a rejected promise

            // call 'before' hooks, possibly modifying `context`
            const beforeAppHooks = appHooks?.before || []
            const beforeMethodHooks = service?._hooks?.before && service._hooks.before[methodName] || []
            const beforeAllHooks = service?._hooks?.before?.all || []
            for (const hook of [...beforeAppHooks, ...beforeMethodHooks, ...beforeAllHooks]) {
               await hook(context)
            }

            // call method
            const result = await method(...args)
            // put result into context
            context.result = result

            // call 'after' hooks, possibly modifying `context`
            const afterMethodHooks = service?._hooks?.after && service._hooks.after[methodName] || []
            const afterAllHooks = service?._hooks?.after?.all || []
            const afterAppHooks = appHooks?.after || []
            for (const hook of [...afterMethodHooks, ...afterAllHooks, ...afterAppHooks]) {
               await hook(context)
            }

            // publish 'service-event' event associated to service/method
            if (service.publishFunction) {
               // collect channel names to socket is member of
               const channelNames = await service.publishFunction(context)
               app.log('verbose', `publish channels ${service.name} ${methodName} ${channelNames}`)
               // send event on all these channels
               if (channelNames.length > 0) {
                  let sender = io.to(channelNames[0])
                  for (let i = 1; i < channelNames.length; i++) {
                     sender = sender.to(channelNames[i])
                  }
                  sender.emit('service-event', {
                     name: service.name,
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
            const hookedMethod = service['__' + methodName]
            return hookedMethod(context, ...args)
         }
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
      services[name] = service
      return service
   }

   function configure(callback) {
      callback(app)
   }

   // set application hooks
   function hooks(hooks) {
      appHooks = hooks
   }

   // `app.service(name)` starts here!
   function service(name) {
      // get service from `services` cache
      if (name in services) return services[name]
      app.log('error', `there is no service named '${name}'`, 'missing-service')
   }

   async function joinChannel(channelName, socket) {
      app.log('verbose', `joining ${channelName}, ${JSON.stringify(socket.data)}`)
      socket.join(channelName)
   }

   async function leaveChannel(channelName, socket) {
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
      hooks,
      joinChannel,
      leaveChannel,
      sendAppEvent,
   })

}
