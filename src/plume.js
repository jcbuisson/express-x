
const express = require('express')


function plume() {
   const app = express()

   function createUserService(param) {
      const f = (x) => param*x
      return f
   }

   return Object.assign(app, {
      createUserService,
   })
}

module.exports = plume
