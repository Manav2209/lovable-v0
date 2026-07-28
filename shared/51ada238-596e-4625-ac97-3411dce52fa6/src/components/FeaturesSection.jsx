import React from 'react';
import { Card } from '@/components/ui/card';

function FeaturesSection() {
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Features</h1>
      <div className="flex flex-wrap justify-center">
        <Card>
          <h2 className="text-xl font-bold mb-2">Automatic Note Taking</h2>
          <p className="text-lg">Our AI meeting note taker takes notes automatically, so you can focus on the conversation.</p>
        </Card>
        <Card>
          <h2 className="text-xl font-bold mb-2">Real-time Transcription</h2>
          <p className="text-lg">Our AI meeting note taker provides real-time transcription, so you can review the conversation as it happens.</p>
        </Card>
      </div>
    </div>
  );
}

export default FeaturesSection;