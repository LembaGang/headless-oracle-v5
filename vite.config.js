import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        docs: 'docs.html',
        verify: 'verify.html',
        privacy: 'privacy.html',
        terms: 'terms.html'
      }
    }
  }
})
