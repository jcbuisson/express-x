
import { io } from 'socket.io-client'
import { v4 } from 'uuid'

function expressxClient() {

   const socket = io()

   const waitingPromises = {}

   socket.on("hello", (arg) => {
      console.log(arg)

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

   function service(name) {
      return {
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
         }
      }
   }

   return {
      service,
      socket,
   }
}

export default expressxClient
