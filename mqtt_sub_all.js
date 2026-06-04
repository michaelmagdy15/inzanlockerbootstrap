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
  console.log('Connected to MQTT broker. Subscribing to wildcard "#" ...');
  client.subscribe('#', (err) => {
    if (err) {
      console.error('Subscription error:', err.message);
    } else {
      console.log('Subscription active. Listening for all messages...');
    }
  });
});

client.on('message', (topic, message) => {
  // Ignore homeassistant/sensor/ or auto-discovery noise if possible to keep log clean
  if (topic.includes('status') || topic.includes('discovery') || topic.includes('state')) {
    // optional filter
  }
  console.log(`[RECEIVED] Topic: ${topic} | Payload: ${message.toString()}`);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});
