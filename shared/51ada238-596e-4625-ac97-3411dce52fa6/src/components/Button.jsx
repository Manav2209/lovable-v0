import React from 'react';
import { Button as ShadcnButton } from '@/components/ui';

const Button = ({ children, onClick }) => {
  return (
    <ShadcnButton onClick={onClick}>{children}</ShadcnButton>
  );
};

export default Button;
