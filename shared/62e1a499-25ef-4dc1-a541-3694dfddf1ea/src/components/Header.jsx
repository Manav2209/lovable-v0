import React from 'react';
import { Button } from '@/components/ui/Button';
import { Sun, Moon } from 'lucide-react';

function Header() {
  return (
    <div className='flex justify-between items-center py-4'>
      <h1 className='text-3xl font-bold'>100Xdevs</h1>
      <Button>
        <Sun className='w-5 h-5' />
      </Button>
      <Button>
        <Moon className='w-5 h-5' />
      </Button>
    </div>
  );
}

export default Header;