import React from 'react';
import { Textarea as ShadcnTextarea } from '@/components/ui';

const Textarea = ({ value, onChange, children }) => {
  return (
    <ShadcnTextarea value={value} onChange={onChange}>{children}</ShadcnTextarea>
  );
};

export default Textarea;
