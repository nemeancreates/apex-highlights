const { io } = require('socket.io-client');

const username = process.argv[2] || 'testuser';
const code = process.argv[3];

if (!code) {
  console.log('Usage: node test-client.js <username> <sessionCode>');
  process.exit(1);
}

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log(`Connected as ${username}, joining session ${code}...`);
  socket.emit('join-session', { code: code, username: username });
});

socket.on('session-joined', (data) => {
  console.log(`Joined session ${data.code}!`);
  console.log('Current members:', data.members.map(m => m.username).join(', '));

  // Simulate starting recording after 2 seconds
  setTimeout(() => {
    console.log('Started recording...');
    socket.emit('recording-status', { isRecording: true });
  }, 2000);

  // Simulate stopping recording after 6 seconds
  setTimeout(() => {
    console.log('Stopped recording.');
    socket.emit('recording-status', { isRecording: false });
  }, 6000);
});

socket.on('member-joined', (data) => {
  console.log(`>> ${data.username} joined the session!`);
});

socket.on('member-left', (data) => {
  console.log(`>> ${data.username} left the session.`);
});

socket.on('member-recording-update', (data) => {
  console.log(`>> ${data.username} ${data.isRecording ? 'started' : 'stopped'} recording`);
});

socket.on('error-message', (data) => {
  console.log(`Error: ${data.message}`);
});