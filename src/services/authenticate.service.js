
const config = require('config')
const jwt = require('jsonwebtoken')


module.exports = function (app) {

   const prisma = app.get('prisma') // BOF

   app.createCustomService({
      name: 'authenticate',

      create: async ({ uid, strategy, username, password }) => {
         console.log('authenticate data', strategy, username, password)
         try {
            const entity = config.authentication.entity
            const usernameField = config.authentication[strategy].usernameField
            const passwordField = config.authentication[strategy].passwordField
            console.log("authenticate-request", uid, strategy, username, password, usernameField, passwordField)
            // check if a user exists with this username
            const where = {}
            where[usernameField] = username
            const user = await prisma[entity].findUnique({ where })
            if (user) {
               // user exists; check password
               if (user.password === password) {
                  const accessToken = jwt.sign({ sub: user.id }, config.authentication.secret, config.authentication.jwtOptions)
                  return {
                     accessToken,
                     user,
                  }
               } else {
                  return {
                     error: "Incorrect credentials",
                  }
               }
            } else {
               return {
                  error: "Incorrect credentials",
               }
            }
         } catch(err) {
            return {
               error: err.toString(),
            }
         }
      },

      patch: async (accessToekn) => {

      }
   })
}
