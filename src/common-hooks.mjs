
import bcrypt from 'bcryptjs'

import { getConnectionDataItem } from './context.mjs'


// hash password of user record
export const hashPassword = (passwordField) => async (context) => {
   context.args[0][passwordField] = await bcrypt.hash(context.args[0][passwordField], 5)
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
   if (context.transport !== 'ws') return
   // extract sessionId from connection data
   const sessionId = await getConnectionDataItem(context, 'sessionId')
   if (!sessionId) throw Error(`Not authenticated (no sessionId in connection data)`)
}

export const isNotExpired = async (context) => {
   if (context.transport !== 'ws') return
   const expireAtISO = await getConnectionDataItem(context, 'expireAt')
   const expireAt = new Date(expireAtISO)
   const now = new Date()
   if (now > expireAt) {
      // DON'T CLEAR CONNECTION DATA, LOGOUT WILL NOT BE ABLE TO RETRIEVE SESSIONID
      // throw exception
      throw new Error('session expired')
   }
}
