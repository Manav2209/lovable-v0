import React from 'react';
import { Card } from '@/components/ui/card';

function TestimonialSection() {
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Testimonials</h1>
      <div className="flex flex-wrap justify-center">
        <Card>
          <p className="text-lg">"The AI meeting note taker has been a game-changer for our team. We can focus on the conversation, not on taking notes."</p>
          <h2 className="text-xl font-bold mb-2">John Doe, CEO</h2>
        </Card>
        <Card>
          <p className="text-lg">"The AI meeting note taker is incredibly accurate and efficient. It's saved us so much time and effort."</p>
          <h2 className="text-xl font-bold mb-2">Jane Smith, Marketing Manager</h2>
        </Card>
      </div>
    </div>
  );
}

export default TestimonialSection;