import React from 'react';
import { Button } from '@/components/ui/button';
import { GoogleAuth } from './GoogleAuth';

const Login = () => {
  return (
    <div>
      <h1>Login</h1>
      <GoogleAuth />
      <Button>Login</Button>
    </div>
  );
};

export default Login;