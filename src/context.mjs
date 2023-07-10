
export async function getContextConnection(context) {
   const id = context.params.connectionId
   const connection = await context.app.prisma.Connection.findUnique({ where: { id }})
   return connection
}

export async function resetConnection(context) {
   const id = context.params.connectionId
   await context.app.prisma.Connection.update({
      where: { id },
      data: {
         data: '{}',
         channelNames: '[]',
      }
   })
}

export async function getConnectionDataItem(context, key) {
   const id = context.params.connectionId
   const connection = await context.app.prisma.Connection.findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   return data[key]
}

export async function setConnectionDataItem(context, key, value) {
   const id = context.params.connectionId
   const connection = await context.app.prisma.Connection.findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   data[key] = value
   await context.app.prisma.Connection.update({
      where: { id },
      data: {
         data: JSON.stringify(data)
      }
   })
}

export async function removeConnectionDataItem(context, key) {
   const id = context.params.connectionId
   const connection = await context.app.prisma.Connection.findUnique({ where: { id }})
   const data = JSON.parse(connection.data)
   delete data[key]
   await context.app.prisma.Connection.update({
      where: { id },
      data: {
         data: JSON.stringify(data)
      }
   })
}

export async function sendServiceEventToClient(context, name, action, result) {
   const id = context.params.connectionId
   const socket = context.app.cnx2Socket[id]
   socket.emit('service-event', {
      name,
      action,
      result,
   })

}