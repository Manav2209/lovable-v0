import './App.css'
import { Button } from './components/ui/button'

function Counter() {
  return <Button>Count: 0</Button>
}

function App() {
  return (
    <main>
      <h1>Counter</h1>
      <Counter />
    </main>
  )
}

export default App
