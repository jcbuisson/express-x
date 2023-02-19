const express = require('express')
const expressX = require('./expressX')


const app = expressX()

app.createDatabaseService('user')


const userService = app.service('user')

userService.get(1).then(user => console.log('user', user))


app.useHTTP('/api/user', userService)



// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

app.server.listen(3030, () => console.log('App listening at http://localhost:3030'))
