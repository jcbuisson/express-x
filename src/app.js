
const expressX = require('./expressX')

const app = expressX()


const userService = app.createDatabaseService('user')
userService.get(1)
   .then(user => console.log('user', user))

app.useHTTP('/api/user', userService)



// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

app.server.listen(3000, () => console.log('App listening at http://localhost:3000'))
