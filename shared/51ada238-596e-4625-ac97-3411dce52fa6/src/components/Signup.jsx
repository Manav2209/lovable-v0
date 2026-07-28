import React from 'react';
import { Button } from '@/components/ui/button';
import { GoogleAuth } from './GoogleAuth';

const Signup = () => {
  return (
    <div>
      <h1>Signup</h1>
      <GoogleAuth />
      <Button>Signup</Button>
    </div>
  );
};

export default Signup;