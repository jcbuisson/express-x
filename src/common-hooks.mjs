
import bcrypt from 'bcryptjs'


export const addTimestamp = (field) => async (context) => {
   context.result[field] = (new Date()).toISOString()
   return context
}

/*
 * Hash password of user record
 * To be used as an 'after' hook for users service methods
*/
export const hashPassword = (passwordField) => async (context) => {
   const user = context.result
   user[passwordField] = await bcrypt.hash(user[passwordField], 5)
   return context
}


/*
 * Remove `field` from `context.result`
*/
export function protect(field) {
   return async (context) => {
      if (Array.isArray(context.result)) {
         for (const value of context.result) {
            delete value[field]
         }
      } else {
         delete context.result[field]
      }
      return (context)
   }
}

/*
 * Does nothing for calls which are not client-side with websocket transport
 * Check if the 'expireAt' key in socket.data is met
 * If it is met, throw an error (which will be sent back to the calling server or client) and reset socket.data
 * If not, do nothing. If needed, an application-level hook may automatically extend the expiration data at each service call
*/
export const isNotExpired = async (context) => {
   // return context
   if (context.caller !== 'client' || context.transport !== 'ws') return
   
   const expireAt = context.socket.data.expireAt
   if (expireAt) {
      const expireAtDate = new Date(expireAt)
      const now = new Date()
      if (now > expireAtDate) {
         // expiration date is met: clear socket.data & throw exception
         const { clientIP } = socket.data
         socket.data = { clientIP }
         throw new Error('session-expired')
      }
   } else {
      throw new Error('session-expired')
   }
}
