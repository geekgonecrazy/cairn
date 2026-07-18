import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Theme: honor a stored preference, else the OS setting. Stamped on <html> so
// the token overrides (html[data-theme="dark"]) apply.
const stored = localStorage.getItem('cairn-theme')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
document.documentElement.dataset.theme = stored ?? (prefersDark ? 'dark' : 'light')

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
