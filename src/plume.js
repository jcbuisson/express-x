
const express = require('express')


function plume() {
   const expressApp = express()


   return Object.assign(expressApp, {
      xyz: 123,
   })
}

module.exports = plume
