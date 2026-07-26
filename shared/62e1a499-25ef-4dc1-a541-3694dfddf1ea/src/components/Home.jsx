import React from 'react';
import { Button } from '@/components/ui/button';
import { Sun } from 'lucide-react';

function Home() {
  return (
    <div className='flex flex-col items-center justify-center h-screen'>
      <h1 className='text-3xl font-bold'>100Xdevs</h1>
      <Button className='mt-4'>Learn More</Button>
      <Sun className='w-6 h-6 text-yellow-500' />
    </div>
  );
}

export default Home;