import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base works for GitHub Pages project sites and local preview.
export default defineConfig({
  plugins: [react()],
  base: './',
})
