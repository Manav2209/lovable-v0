import './App.css'
import { Button } from './components/ui/button'

function Home() {
  return (
    <section>
      <h1>Home</h1>
      <p>Welcome to the existing app.</p>
      <Button>Hello</Button>
    </section>
  )
}

function App() {
  return (
    <main>
      <nav>
        <a href="#home">Home</a>
      </nav>
      <Home />
    </main>
  )
}

export default App
