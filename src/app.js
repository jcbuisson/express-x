
const plume = require('./plume')

const app = plume()


const userService = app.createDatabaseService('user')
app.useService('/api/user', userService)

userService.get(1).then(x => console.log('x', x))


// serve index.html
app.get('/', function (req, res) {
   res.sendFile(__dirname + '/index.html')
})

app.server.listen(3000, () => console.log('App listening at http://localhost:3000'))
