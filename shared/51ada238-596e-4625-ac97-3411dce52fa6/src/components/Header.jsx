import React from 'react';
import { Button } from '@/components/ui/button';
import { Moon, Sun } from 'lucide-react';

function Header() {
  return (
    <div className="flex justify-between items-center py-4">
      <h1 className="text-2xl font-bold">AI Meeting Note Taker</h1>
      <Button>
        <Moon size={24} />
      </Button>
    </div>
  );
}

export default Header;