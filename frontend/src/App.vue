<template>
   <input v-model="email"> <button @click="addUser">add</button>
   <div v-for="user in users">
      <li>{{ user.email  }}</li>
   </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import expressxClient from './expressx-client'


const app = expressxClient()

const users = ref([])
const email = ref()

app.service('user').on('created', user => {
   console.log('USER EVENT created', user)
})


onMounted(async () => {
   users.value = await app.service('user').find()
})

const addUser = async () => {
   const user = await app.service('user').create({
      email: email.value,
   })
   console.log('created user', user)
}
</script>
