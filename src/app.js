
const express = require('express')
const { enhanceExpress } = require('./expressX')

const mailService = require('./services/mail.service')
const authenticateService = require('./services/authenticate.service')


const app = express()
enhanceExpress(app)


app.createDatabaseService({name: 'user', client: 'prisma' })

// app.createAuthService(config.get('authentication'))

app.configure(mailService)
app.configure(authenticateService)


app.httpRestService('/api/user', app.service('user'))


// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

app.server.listen(3030, () => console.log('App listening at http://localhost:3030'))


app.on('connection', (connection) => {
   console.log('connection', connection.id)
   app.joinChannel('everyone', connection)
})

app.service('user').publish(async (user, context) => {
   return ['everyone']
})
