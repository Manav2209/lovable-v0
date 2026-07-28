import React, { useState } from 'react';
import { Button, Textarea } from '@/components/ui';

const MeetingNoteTaker = () => {
  const [meetingNotes, setMeetingNotes] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const handleStartRecording = () => {
    setIsRecording(true);
  };
  const handleStopRecording = () => {
    setIsRecording(false);
  };
  return (
    <div>
      <h1>AI Meeting Note Taker</h1>
      <Button onClick={handleStartRecording}>Start Recording</Button>
      <Button onClick={handleStopRecording}>Stop Recording</Button>
      <Textarea value={meetingNotes} onChange={(e) => setMeetingNotes(e.target.value)} />
    </div>
  );
};

export default MeetingNoteTaker;
