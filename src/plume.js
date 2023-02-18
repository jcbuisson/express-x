
const express = require('express')


function plume() {
   const app = express()

   function service(name) {
      const f = (x) => name + x
      return f
   }

   return Object.assign(app, {
      service,
   })
}

module.exports = plume
