const express = require('express')
// const http = require('http')
// const socketio = require('socket.io')
const { createServer } = require("http")
const { Server } = require("socket.io")

const plume = require('./plume')

const app = plume()

app.use(express.urlencoded({ extended: true }))
app.use(express.json())


const userService = app.createDatabaseService('user')
app.useREST('/api/user', userService)



// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

// const server = new http.Server(app)
// const io = new socketio.Server(server)
const httpServer = createServer(app)
const io = new Server(httpServer, {
   cors: {
      origin: "http://localhost:3000"
   }
})
app.listen(3000, () => console.log('App listening at http://localhost:3000'))



io.on('connection', function(socket) {
   console.log('Client connected to the WebSocket')

   socket.emit("hello", "world")

   socket.on('disconnect', () => {
      console.log('Client disconnected')
   })

   socket.on('chat message', function(msg) {
      console.log("Received a chat message")
      io.emit('chat message', msg)
   })
})
