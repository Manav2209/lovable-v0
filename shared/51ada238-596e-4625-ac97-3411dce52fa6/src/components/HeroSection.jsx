import React from 'react';
import { Button } from '@/components/ui/button';

function HeroSection() {
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-3xl font-bold mb-4">Take notes automatically with our AI-powered meeting note taker.</h1>
      <p className="text-lg mb-4">Our AI meeting note taker is designed to help you focus on the conversation, not on taking notes.</p>
      <Button>Get Started</Button>
    </div>
  );
}

export default HeroSection;