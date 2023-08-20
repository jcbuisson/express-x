

# Getting started

## Create a project

Let's create a new folder for our application:

```bash
mkdir expressx-project
cd expressx-project
```

Since any ExpressX application is a Node application, we can create a default package.json using npm:

```bash
npm init es6 --yes
```

The `es6` argument adds `"type": "module"` in `package.json`. Beware! All further module imports must made with es6/esm `import` syntax.


## Install ExpressX

```bash
npm install @jcbuisson/express-x
```

## Our first server application

Now we can create an ExpressX application which will provide a complete REST API on a `user` resource
backed in a [Prisma](https://www.prisma.io/) database

```js
// app.js
import bodyParser from 'body-parser'
import { expressXServer } from '@jcbuisson/express-x'

// `app` is a regular express application, enhanced with service and real-time features
const app = expressX()

// create two CRUD database services. They provide Prisma methods: `create`, 'createMany', 'find', 'findMany', 'upsert', etc.
app.createDatabaseService('User')
app.createDatabaseService('Post')

// add body parsers for http requests
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))

// add http/rest endpoints
app.addHttpRest('/api/user', app.service('User'))
app.addHttpRest('/api/post', app.service('Post'))

app.server.listen(8000, () => console.log(`App listening at http://localhost:8000`))
```

Before running it we need to setup the corresponding database.


## Create the database

Presently, ExpressX only handles [Prisma](https://www.prisma.io/). Prisma is able to connect to most brands of relational or NoSQL databases.

First, provide the database schema in `prisma/schema.prisma`:
```prisma
generator client {
   provider = "prisma-client-js"
}

model User {
   id          Int       @default(autoincrement()) @id
   name        String
   posts       Post[]
}

model Post {
   id          Int       @default(autoincrement()) @id
   text        String
   author      User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
   authorId    Int
}

datasource db {
   provider = "sqlite"
   url      = "file:./dev.db"
}
```

Then create the database:
```bash
npx prisma migrate dev --name init
```

The sqlite database file is created at `prisma/dev.db`


## Run the application

```bash
node app.js
```

It prints the following lines in the console:
```bash
created service 'user' over entity 'User'
created service 'post' over entity 'Post'
added HTTP endpoints for service 'user' at path '/api/user'
added HTTP endpoints for service 'post' at path '/api/post'
App listening at http://localhost:8000
```


## Enjoy your HTTP REST API

Now you can try the HTTP endpoints `/api/user` and `/api/post`; open a new console and run HTTP requests:
```bash
curl -X POST -H 'Content-Type: application/json' -d '{"name":"JC"}' http://localhost:8000/api/user
# --> {"id":1,"name":"JC"}
curl http://localhost:8000/api/user
# --> [{"id":1,"name":"JC"}]
```

With a few lines of code, we got a complete REST API over the database tables. But there is more!


## Use it with a websocket client

Create the following client NodeJS script:

```js
// client.js
import io from 'socket.io-client'
import { expressXClient } from '@jcbuisson/express-x'

const socket = io('http://localhost:8000', { transports: ["websocket"] })

const app = expressXClient(socket)

async function main() {
   const user = await app.service('User').create({
      name: "Joe",
   })
   await app.service('Post').create({
      authorId: user.id,
      text: "Post#1"
   })
   await app.service('Post').create({
      authorId: user.id,
      text: "Post#2"
   })
   const joe = await app.service('User').findUnique({
      where: {
         id: user.id,
      },
      include: {
         posts: true,
      },
   })
   console.log('joe', joe)
   process.exit(0)
}
main()
```

For simplicity we use a node client, but you of course you would write something similar with your favorite front-end framework.

You can use on the client side the exact same statements on services as you would on the server side, such as: `app.service('User').create(...)`.
Of course the `app` object here on the client is quite different that the `app` object on the server; you can find explanations [here]().

Now run the client script:
```bash
node client.js
```

It prints the following lines in the console:
```json
joe {
  id: 11,
  name: 'Joe',
  posts: [
    { id: 12, text: 'Post#1', authorId: 11 },
    { id: 13, text: 'Post#2', authorId: 11 }
  ]
}
```

We have a GraphQL-like experience with the nested posts, thanks to Prisma and its use through ExpressX services.

::: info
We could have removed from `app.js` all lines related to HTTP, since we are only using the websocket transport.
:::


## Real-time applications

When websocket transport is used (default situation) and when a connected client calls a service method,
two twings happen on method completion:

- the resulting value is sent to the client
- an event is emitted, and sent to connected clients we'll call subscribers. The calling client may or not be one of those subscribers.

For example in a medical application, whenever a patients's record is modified, an event could be sent to all his/her caregivers.

***Channels*** are used for this pub/sub mechanism. Service methods ***publish*** events on ***channels***, and clients ***subscribe***
to channels in order to receive those events. ExpressX provides functions to configure which events are published to which channels.
A channel is represented by a name and you can create and use as many channels as you need.

In the following example, every time a client connects to the server, it joins (= is subscribed to) the 'anonymous' channel.
And whenever an event is emited by the `post` or `user` service, this event is published on this channel,
and then broacasted to all connected clients, leading to real-time updates.

```js
// app.js
import { expressXServer } from '@jcbuisson/express-x'
import { PrismaClient } from '@prisma/client'

// `app` is a regular express application, enhanced with service and real-time features
const app = expressX()

// configure prisma client from schema
app.set('prisma', new PrismaClient())

// create two CRUD database services. They provide Prisma methods: `create`, 'createMany', 'find', 'findMany', 'upsert', etc.
app.createDatabaseService('User')
app.createDatabaseService('Post')

// publish
app.service('User').publish(async (post, context) => {
   return ['anonymous']
})
app.service('Post').publish(async (post, context) => {
   return ['anonymous']
})

// subscribe
app.on('connection', (connection) => {
   console.log('connection', connection.id)
   app.joinChannel('anonymous', connection)
})

app.server.listen(8000, () => console.log(`App listening at http://localhost:8000`))
```

Here is how a client may listen to channel events:

```js
...
app.service('Post').on('create', post => {
   console.log('post event created', post)
})
```

The listener is triggered whenever the client receives from the server a `create` event from the service `post`.
This event results from the completion on the server of a call `app.service('Post').create()`
