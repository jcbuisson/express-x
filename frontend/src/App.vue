<template>
   <div> <input v-model="pseudo"> pseudo </div>
   <div> <input v-model="password"> password </div>
   <button @click="signin">signin</button>
   <button @click="addUser">add</button>
   <hr>
   
   <div v-for="user in users">
      <li>{{ user.name  }}</li>
   </div>
   <button @click="sendMail">send mail</button>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import expressxClient from './expressx-client'


const app = expressxClient()
// app.configure(feathers.authentication({ storage: window.sessionStorage }))


const users = ref([])
const pseudo = ref()
const password = ref()


app.service('user').on('created', user => {
   console.log('USER EVENT created', user)
   users.value.push(user)
})


onMounted(async () => {
   users.value = await app.service('user').find()
})

const addUser = async () => {
   const user = await app.service('user').create({
      pseudo: pseudo.value,
      password: password.value,
   })
   console.log('created user', user)
}

const signin = async () => {
   const { error, accessToken, user } = await app.service('authenticate').create({
      strategy: 'local',
      username: pseudo.value,
      password: password.value,
   })
   console.log('authenticate', error, accessToken, user)
   if (error) {

   } else {
      window.sessionStorage.setItem('feathers-jwt', accessToken)
   }
}

const sendMail = () => {
   app.service('mailer').create({
      to: "buisson@n7.fr",
      from: "buisson@nasa.gov",
      subject: "Fake",
      text: "Hello from NASA",
   })
}

</script>
