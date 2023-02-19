#!/usr/bin/env node
const { io } = require("socket.io-client");


async function main() {
   try {
      const socket = io(`http://localhost:3030`)

      socket.on("hello", (arg) => {
         console.log(arg)

         socket.emit('find-request', {
            uid: 'azer',
            name: 'user',
         })
      })

      socket.on("find-response", ({ uid, values }) => {
         console.log('find-response', uid, values)
      })

   } catch(err) {
      console.log("*** error", err)
   }
}

main()

