
import bcrypt from 'bcryptjs'

import { EXError } from './server.mjs'

/*
 * Add a timestamp property of name `field` with current time as value
*/
export const addTimestamp = (field) => async (context) => {
   context.result[field] = (new Date()).toISOString()
   return context
}

/*
 * Hash password of the property `field`
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

export const isNotExpired = async (context) => {
   // do nothing if it's not a client call from a ws connexion
   if (!context.socket) return
   const expiresAt = context.socket.data.expiresAt
   if (expiresAt) {
      const expiresAtDate = new Date(expiresAt)
      const now = new Date()
      if (now > expiresAtDate) {
         // expiration date is met
         // clear socket.data
         context.socket.data = {}
         // leave all rooms except socket#id
         const rooms = new Set(context.socket.rooms)
         for (const room of rooms) {
            if (room === context.socket.id) continue
            context.socket.leave(room)
         }
         // send an event to the client (typical client handling: logout)
         context.socket.emit('expired')
         // throw exception
         throw new EXError('not-authenticated', "Session expired")
      }
   } else {
      throw new EXError('not-authenticated', "No expiresAt in socket.data")
   }
}

/*
 * Throw an error for a client service method call when socket.data does not contain user
*/
export const isAuthenticated = async (context) => {
   // do nothing if it's not a client call from a ws connexion
   if (!context.socket) return
   if (!context.socket.data.user) throw new EXError('not-authenticated', 'no user in socket.data')
}

/*
 * Extend value of socket.data.expiresAt of `duration` milliseconds
*/
export const extendExpiration = (duration) => async (context) => {
   const now = new Date()
   context.socket.data.expiresAt = new Date(now.getTime() + duration)
}