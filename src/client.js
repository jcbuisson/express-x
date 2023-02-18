#!/usr/bin/env node
const { io } = require("socket.io-client");


async function main() {
   try {
      const socket = io(`http://localhost:3000`)

      socket.on("hello", (arg) => {
         console.log(arg)
      })

   } catch(err) {
      console.log("*** error", err)
   }
}

main()

