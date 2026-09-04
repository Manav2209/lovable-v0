import './App.css'
import { useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'

function App() {
  const [tasks, setTasks] = useState(["Buy milk"])
  const [text, setText] = useState("")

  return (
    <main>
      <h1>Todos</h1>
      <Input value={text} onChange={(e) => setText(e.target.value)} />
      <Button onClick={() => { if (!text) return; setTasks((t) => [...t, text]); setText(""); }}>Add</Button>
      <ul>
        {tasks.map((task, i) => (
          <li key={i}>
            {task}
            <Button onClick={() => setTasks((t) => t.filter((_, j) => j !== i))}>delete</Button>
          </li>
        ))}
      </ul>
    </main>
  )
}

export default App
