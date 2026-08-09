import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.AGENT_SERVER_PORT ?? '4001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://localhost:${backend}`,
      '/ws': {
        target: `ws://localhost:${backend}`,
        ws: true,
      },
    },
  },
})
