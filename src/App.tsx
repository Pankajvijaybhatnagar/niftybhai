import Hero from './components/Hero.tsx'
import CrudeOil from './components/CrudeOil.tsx'

import { Routes, Route } from 'react-router-dom';

import './App.css'

function App() {


  return (
    <>
     
      <Routes>
        <Route path="/" element={<Hero />} />
        <Route path="/crude" element={<CrudeOil/>} />
      </Routes>
    </>
  )
}

export default App
