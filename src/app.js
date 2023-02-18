const http = require('http')
const socketio = require('socket.io')

const plume = require('./plume')

const app = plume()


const userService = app.service('user')
app.useREST('/api/user', userService)

userService.get(1).then(x => console.log('x', x))


// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

const server = new http.Server(app)
const io = new socketio.Server(server)
server.listen(3000, () => console.log('App listening at http://localhost:3000'))



io.on('connection', function(socket) {
   console.log('Client connected to the WebSocket')

   socket.emit('hello', 'world')

   socket.on('disconnect', () => {
      console.log('Client disconnected')
   })

   socket.on('chat message', function(msg) {
      console.log("Received a chat message")
      io.emit('chat message', msg)
   })
})
