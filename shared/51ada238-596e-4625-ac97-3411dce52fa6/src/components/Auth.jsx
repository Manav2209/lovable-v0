import React from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { User } from 'lucide-react';

const Auth = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isLogin) {
      // Login logic here
      console.log('Login:', username, password);
    } else {
      // Signup logic here
      console.log('Signup:', username, password);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-10 p-4 rounded-lg bg-card">
      <h2 className="text-lg font-bold mb-2">{isLogin ? 'Login' : 'Signup'}</h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <Label>Username</Label>
          <Input type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="mb-4">
          <Label>Password</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit">{isLogin ? 'Login' : 'Signup'}</Button>
        <button type="button" onClick={() => setIsLogin(!isLogin)} className="mt-2">
          {isLogin ? 'Create an account' : 'Already have an account'}
        </button>
      </form>
    </div>
  );
};

export default Auth;