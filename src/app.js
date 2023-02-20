
const express = require('express')
const { enhanceExpress } = require('./expressX')


const app = express()
enhanceExpress(app)


app.createDatabaseService('user')


const userService = app.service('user')

// userService.get(1).then(user => console.log('user', user))


app.httpRestService('/api/user', userService)


// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

app.server.listen(3030, () => console.log('App listening at http://localhost:3030'))


app.on('connection', (connection) => {
   console.log('connection', connection.id)
   // app.channel('everyone').join(connection)
   app.joinChannel('everyone', connection)
})

app.service('user').publish(async (user, context) => {
   return ['everyone']
})

