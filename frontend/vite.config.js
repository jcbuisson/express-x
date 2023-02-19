import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
   plugins: [
      vue()
   ],
   server: {
      port: 3000,
      open: true,
      host: true, // allows for external device connection on local network
      proxy: {
         '^/socket.io/.*': {
            target: 'http://localhost:3030',
            changeOrigin: true,
            ws: true,
            secure: false,
         },
         '/api': {
            target: 'http://localhost:3030',
            changeOrigin: true,
            ws: false,
            secure: false,      
         },
      }
   },
})
