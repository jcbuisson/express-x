const http = require('http')
const socketio = require('socket.io')

const { PrismaClient } = require('@prisma/client')

const plume = require('./plume')

// const { UserService } = require('./services/user.service')


// const app = express()
const app = plume()

const prisma = new PrismaClient()


const userService = app.service('User')
// console.log('xx', userService(3))

const users = await userService.find()

// app.use('/api/users', userService)

app.get('/users', async (req, res) => {
   const users = await prisma.user.findMany()
   res.json(users)
})


// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

const server = new http.Server(app)
const io = new socketio.Server(server)
server.listen(3000, () => console.log('App listening at http://localhost:3000'))



io.on('connection', function(socket) {
   console.log('Client connected to the WebSocket')

   socket.on('disconnect', () => {
      console.log('Client disconnected')
   })

   socket.on('chat message', function(msg) {
      console.log("Received a chat message")
      io.emit('chat message', msg)
   })
})
