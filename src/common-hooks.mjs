
import bcrypt from 'bcryptjs'


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
