
import bcrypt from 'bcryptjs'

import { getConnectionDataItem } from './context.mjs'
import { MyCustomError } from '.server.mjs'


// hash password of user record
export const hashPassword = (passwordField) => async (context) => {
   // context.result is a user
   context.result[passwordField] = await bcrypt.hash(context.result[passwordField], 5)
   return context
}

// remove `field` from `result`
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


export async function isAuthenticated(context) {
   // extract sessionId from connection data
   const sessionId = await getConnectionDataItem(context, 'sessionId')
   if (!sessionId) throw new MyCustomError("not authenticated", 'not-authenticated')
}

export const isNotExpired = async (context) => {
   const expireAt = await getConnectionDataItem(context, 'expireAt')
   if (expireAt) {
      const expireAtDate = new Date(expireAt)
      const now = new Date()
      if (now > expireAtDate) {
         // expiration date is met: clear connection data & throw exception
         await resetConnection(context)
         throw new MyCustomError("session expired", 'session-expired')
      }
   } else {
      throw new MyCustomError("session expired", 'session-expired')
   }
}
