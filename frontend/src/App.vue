<template>
   {{ users  }}
</template>

<script setup>
import { ref, onMounted } from 'vue'
import expressxClient from './expressx-client'


const app = expressxClient()

const users = ref([])

onMounted(async () => {
   users.value = await app.service('user').find()
})
</script>
