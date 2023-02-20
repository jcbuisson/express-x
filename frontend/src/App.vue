<template>
   {{ users  }}
</template>

<script setup>
import { ref, onMounted } from 'vue'
import expressxClient from './expressx-client'


const app = expressxClient()

const users = ref([])

// app.service('user').on('created', user => {
//    console.log('USER EVENT created', user)
// })


onMounted(async () => {
   users.value = await app.service('user').find()
})
</script>
