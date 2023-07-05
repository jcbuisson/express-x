
import config from 'config'
import bcrypt from 'bcryptjs'

import { getConnectionDataItem } from './context.mjs'


// hash password of user record
// name of the password field is found in `config.authentication.local.passwordField` (default: 'password')
export async function hashPassword(context) {
   const passwordField = config.authentication.local.passwordField
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
   // extract user from connection data
   const user = await getConnectionDataItem(context, 'user')
   // const id = context.params.connectionId
   // const connection = await context.app.service('Connection')._findUnique({ where: { id }})
   // const data = JSON.parse(connection.data)
   // const user = data.user
   if (!user) throw Error(`AuthCode hook: not authenticated ${id}`)
}
