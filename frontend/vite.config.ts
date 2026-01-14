import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Expose only the specific env vars we need to the client.
  // Note: this still means the API key is available in the browser when using client-side AI.
  envPrefix: ['VITE_', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
