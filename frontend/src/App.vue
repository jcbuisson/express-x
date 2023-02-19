<template>
   {{ users  }}
</template>

<script setup>
import { ref, onMounted } from 'vue'

import app from './expressx-client'


const users = ref([])

onMounted(async () => {
   users.value = await app.service('user').find()
})
</script>
