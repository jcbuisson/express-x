
const express = require('express')


function plume() {
   const app = express()

   function service(name) {
      return {
         find: () => {
            return [1, 2, 3]
         }
      }
   }

   return Object.assign(app, {
      service,
   })
}

module.exports = plume
