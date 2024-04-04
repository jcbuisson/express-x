
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
 * Throw an error for a client service method call when socket.data.expiresAt is missing or overdue
*/
export const isNotExpired = async (context) => {
   // do nothing if it's not a client call from a ws connexion
   if (!context.socket) return
   const expiresAt = context.socket.data.expiresAt
   if (expiresAt) {
      const expiresAtDate = new Date(expiresAt)
      const now = new Date()
      if (now > expiresAtDate) {
         // expiration date is met: clear socket.data & throw exception
         context.socket.data = {}
         throw new Error('session-expired')
      }
   } else {
      throw new Error('session-expired')
   }
}

/*
 * Throw an error for a client service method call when socket.data does not contain user
*/
export const isAuthenticated = async (context) => {
   // do nothing if it's not a client call from a ws connexion
   if (!context.socket) return
   if (!context.socket.data.user) throw new Error('not-authenticated')
}
