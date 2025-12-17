
Full doc: [https://expressx.jcbuisson.dev](https://expressx.jcbuisson.dev)

# Getting started

ExpressX is a framework handling both backend and frontend and their communication using websockets.\
A single websocket is used to channel both data and events between the server and each client.

```bash
mkdir myproject
cd myproject
mkdir backend frontend
```

## Initialize backend

`@jcbuisson/express-x` is the server-side library

```bash
cd backend
npm init es6
npm install @jcbuisson/express-x cors
```

## Back-end example with a custom service

The following example provides a 'math' service with two custom functions 'square' and 'cube':

```js
// app.js
import { expressX } from '@jcbuisson/express-x';
import cors from 'cors'

// `app` is a regular express application, enhanced with express-x services and real-time features
const app = expressX();
// regular express middleware, to allow access from our front-end
app.use(cors());

// create a custom 'math' service with 2 methods
app.createService('math', {
   square: (x) => x*x,
   cube: (x) => x*x*x,
});

app.httpServer.listen(8000, () => console.log(`App listening at http://localhost:8000`));
```

A service may have as many parameters as needed, of any types as long as they are serializable.

## Run back-end
```
node app.js
```

## Initialize front-end

`@jcbuisson/express-x-client` is the client-side library

```bash
cd frontend
npm init es6
npm install @jcbuisson/express-x-client socket.io-client
```

## Front-end example

index.html

```js
<html>
   <button id="compute-id" class="btn">Compute</button>
   <input id="value-id" type="number" placeholder="Enter value"><br>
   <p id="result-id"></p>
</html>

<script type="module">
import io from 'socket.io-client';
import expressXClient from '@jcbuisson/express-x-client';

const socket = io('http://localhost:8000', {
   transports: ["websocket"],
});

const app = expressXClient(socket);

const computeBtn = document.getElementById('compute-id');
const valueInput = document.getElementById('value-id');
const resultParagraph = document.getElementById('result-id');

computeBtn.addEventListener('click', async (ev) => {
   const result = await app.service('math').square(valueInput.value);
   resultParagraph.innerHTML = result;
})
</script>
```

## Run front-end
```
npx vite
```

Calling a service method from the frontend is as easy as `await app.service('math').square(value)`


## Add a CRUD API over a relational database

With a few more lines to the backend, we can add a complete CRUD API on a `User` resource
backed in a [Prisma](https://www.prisma.io/) database

```js
// app.js
import { expressX } from '@jcbuisson/express-x'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// `app` is a regular express application, enhanced with express-x services and real-time features
const app = expressX()

...

// Create a CRUD database 'user' service with the Prisma methods: `create`, 'findUnique', etc.
// Conveniently, `Prisma.User` is the map of all CRUD methods on User table
app.createService('user', Prisma.User)

app.httpServer.listen(8000, () => console.log(`App listening at http://localhost:8000`))
```

Of course the database must be created and setup first.

Now the full API of Prisma is accessible from the client-side, for example:
```js
const user = await app.service('user').findUnique({ where: { id: userId }})
```

By default, errors on the server-side are serialized and re-emitted on the client-side, so you can catch them if needed.


## Run a NodeJS client script

Of course the client-side ExpressX library can be used in a NodeJS script:

```js
// client.js
import io from 'socket.io-client'
import expressXClient from '@jcbuisson/express-x-client'

const socket = io('http://localhost:8000')

const app = expressXClient(socket)

async function main() {
   const result = await app.service('math').cube(3);
   const joe = await app.service('user').create({
      data: {
         name: "Joe"
      }
   })
   process.exit(0)
}
main()
```


## Real-time applications

When a connected client calls a service method, two things happen on method completion:

- the resulting value is sent to the client
- an event is emitted, and sent to connected clients we'll call subscribers. The calling client may or not be one of those subscribers.

For example in a medical application, whenever a patients's record is modified, an event could be sent to all his/her caregivers.

***Channels*** are used for this pub/sub mechanism. Service methods ***publish*** events on ***channels***, and clients ***subscribe***
to channels in order to receive those events. ExpressX provides functions to configure which events are published to which channels.
A channel is represented by a name and you can create and use as many channels as you need.

In the following example of a shared bilboard, every time a client connects to the server, it joins (= is subscribed to) the 'all' channel.
And whenever an event is emited by the `bilboard` service, this event is published on this channel,
and then broacasted to all connected clients, leading to real-time updates.

```js
// app.js
// Run it with: `node app.js`
import { expressX } from '@jcbuisson/express-x';
import cors from 'cors'

// `app` is a regular express application, enhanced with express-x services and real-time features
const app = expressX();
// express middleware which prevents cors issues with dev front-end
app.use(cors());

let bilboard = '';

// create a custom 'bilboard' service with 1 method
app.createService('bilboard', {
   sendMessage: (message) => {
      bilboard = message;
      return message;
   }
});

// publish
app.service('bilboard').publish(async (context) => {
   return ['all']
});

// subscribe
app.on('connection', (socket) => {
   app.joinChannel('all', socket)
})

app.httpServer.listen(8000, () => console.log(`App listening at http://localhost:8000`));
```

```js
<!-- index.html; run it with: npx vite -->
<html>
   <input id="message-id" type="text" placeholder="Enter message"><br>
   <button id="send-id" class="btn">Send</button>

   <div id="bilboard-id"></div>
</html>

<script type="module">
import io from 'socket.io-client';
import expressXClient from '@jcbuisson/express-x-client';

const socket = io('http://localhost:8000', {
   transports: ["websocket"],
});

const app = expressXClient(socket);

const messageInput = document.getElementById('message-id');
const sendBtn = document.getElementById('send-id');
const bilboardDiv = document.getElementById('bilboard-id');

sendBtn.addEventListener('click', async (ev) => {
   await app.service('bilboard').sendMessage(messageInput.value);
});

app.service('bilboard').on('sendMessage', (message) => {
   bilboardDiv.innerHTML = bilboardDiv.innerHTML + '<br>' + message;
})
</script>
```

The listener is triggered whenever the client receives from the server a `sendMessage` event from the `bilboard` service.
This event is sent to all subscribers after the execution of `app.service('bilboard').sendMessage()` on the server.


### CRUD example

In this other example, every time a client connects to the server, it joins (= is subscribed to) the 'anonymous' channel.
And whenever an event is emited by the `post` or `user` service, this event is published on this channel,
and then broacasted to all connected clients, leading to real-time updates.

```js
// app.js
import { expressX } from '@jcbuisson/express-x';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// `app` is a regular express application, enhanced with express-x services and real-time features
const app = expressX(prisma);

// create two CRUD database services with the Prisma methods: `create`, 'update', etc
app.createService('user', prisma.User);
app.createService('post', prisma.Post);

// publish
app.service('user').publish(async (context) => {
   return ['anonymous']
});
app.service('post').publish(async (context) => {
   return ['anonymous']
});

// subscribe
app.addConnectListener((socket) => {
   app.joinChannel('anonymous', socket)
});

app.httpServer.listen(8000, () => console.log(`App listening at http://localhost:8000`));
```

Here is how a client may listen to channel events:

```js
import io from 'socket.io-client'
import expressXClient from '@jcbuisson/express-x-client'

const socket = io('http://localhost:8000', { transports: ["websocket"] })

const app = expressXClient(socket)


app.service('user').on('create', (user) => {
   console.log('User created', user)
   // update client cache
})

app.service('post').on('create', (post) => {
   console.log('Post created', post)
   // update client cache
})
```

The listener is triggered whenever the client receives from the server a `create` event from the service `post`.
This event is sent to all subscribers after the execution of `app.service('post').create()` on the server.
