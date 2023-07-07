
export async function getContextConnection(context) {
   const id = context.params.connectionId
   const connection = await context.app.service('Connection')._findUnique({ where: { id }})
   return connection
}

export async function resetConnection(context) {
   const id = context.params.connectionId
   await context.app.service('Connection')._update({
      where: { id },
      data: {
         clientIP: '',
         data: '{}',
         channelNames: '[]',
      }
   })
}

export async function getConnectionDataItem(context, key) {
   const id = context.params.connectionId
   const connection = await context.app.service('Connection')._findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   return data[key]
}

export async function setConnectionDataItem(context, key, value) {
   const id = context.params.connectionId
   const connection = await context.app.service('Connection')._findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   data[key] = value
   await context.app.service('Connection')._update({
      where: { id },
      data: {
         data: JSON.stringify(data)
      }
   })
}

export async function removeConnectionDataItem(context, key) {
   const id = context.params.connectionId
   const connection = await context.app.service('Connection')._findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   delete data[key]
   await context.app.service('Connection').update({
      where: { id },
      data: {
         data: JSON.stringify(data)
      }
   })
}

export async function sendEventToClient(context, type, value) {
   const id = context.params.connectionId
   const socket = context.app.cnx2Socket[id]
   socket.emit(type, value)
}