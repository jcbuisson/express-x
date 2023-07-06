
export async function getChannelConnections(channelName) {
   const connections = await app.service('Connection').findMany({})
   return connections.filter(connection => {
      const channelNames = JSON.parse(connection.channelNames)
      return channelNames.includes(channelName)
   })
}

export async function addChannelToConnection(connection, channelName) {
   const channelNames = JSON.parse(connection.channelNames)
   if (!channelNames.includes(channelName)) channelNames.push(channelName)
   await app.service('Connection').update({
      where: { id: connection.id },
      data: { channelNames: JSON.stringify(channelNames) },
   })
}

export async function removeChannelFromConnection(connection, channelName) {
   const channelNames = JSON.parse(connection.channelNames).filter(name => name !== channelName)
   await app.service('Connection').update({
      where: { id },
      data: { channelNames: JSON.stringify(channelNames) },
   })
}
