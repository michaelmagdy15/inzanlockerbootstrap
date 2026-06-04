const mqtt = require('mqtt');

const brokerUrl = 'mqtt://192.168.10.31:1883';
const options = {
  username: 'mqtt',
  password: 'mqttpass',
  connectTimeout: 5000
};

console.log(`Connecting to local broker at ${brokerUrl}...`);
const client = mqtt.connect(brokerUrl, options);

client.on('connect', () => {
  console.log('Connected to MQTT broker. Subscribing to gym/lockers/# ...');
  client.subscribe('gym/lockers/#', (err) => {
    if (err) {
      console.error('Subscription error:', err.message);
    } else {
      console.log('Subscription active. Listening for commands...');
    }
  });
});

client.on('message', (topic, message) => {
  console.log(`[RECEIVED] Topic: ${topic} | Payload: ${message.toString()}`);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});
