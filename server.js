require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { TikTokConnectionWrapper, getGlobalConnectionCount } = require('./connectionWrapper');
const { clientBlocked } = require('./limiter');

const app = express();
const httpServer = createServer(app);

// Enable cross origin resource sharing
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

io.on('connection', async (socket) => {
  let tiktokConnectionWrapper;
  let spreadsheetId;
  let username;

  console.info('New connection from origin', socket.handshake.headers.origin || socket.handshake.headers.referer);

  socket.on('setUniqueId', async (uniqueId, options) => {
    // Prohibit the client from specifying these options (for security reasons)
    if (options && options.spreadsheetId) {
      delete options.requestOptions;
      delete options.websocketOptions;
      spreadsheetId = options.spreadsheetId;
      username = uniqueId;
      delete options.spreadsheetId;
    } else {
      options = {};
    }

    // Session ID in .env file is optional
    if (process.env.SESSIONID) {
      options.sessionId = process.env.SESSIONID;
      console.info('Using SessionId');
    }

    // Check if rate limit exceeded
    if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
      socket.emit('tiktokDisconnected', 'You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.');
      return;
    }

    // Connect to the given username (uniqueId)
    try {
      tiktokConnectionWrapper = new TikTokConnectionWrapper(uniqueId, options, true);
      tiktokConnectionWrapper.connect();
    } catch (err) {
      socket.emit('tiktokDisconnected', err.toString());
      return;
    }

    // Redirect wrapper control events once
    tiktokConnectionWrapper.once('connected', (state) => socket.emit('tiktokConnected', state));
    tiktokConnectionWrapper.once('disconnected', (reason) => socket.emit('tiktokDisconnected', reason));

    // Notify client when stream ends
    tiktokConnectionWrapper.connection.on('streamEnd', () => socket.emit('streamEnd'));

    // Redirect message events
    tiktokConnectionWrapper.connection.on('roomUser', (msg) => socket.emit('roomUser', msg));
    tiktokConnectionWrapper.connection.on('member', (msg) => socket.emit('member', msg));
    tiktokConnectionWrapper.connection.on('chat', async (msg) => {
      socket.emit('chat', msg);

      // Write the new message to the Google Spreadsheet
      if (spreadsheetId) {
        try {
          const doc = new GoogleSpreadsheet(spreadsheetId);
          const config = {
            type: process.env.GOOGLE_ACCOUNT_TYPE,
            project_id: process.env.GOOGLE_PROJECT_ID,
            private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
            private_key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'),
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            client_id: process.env.GOOGLE_CLIENT_ID,
            auth_uri: process.env.GOOGLE_AUTH_URI,
            token_uri: process.env.GOOGLE_TOKEN_URI,
            auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
            client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
          };

          await doc?.useServiceAccountAuth(config, 'oleksandra-kalinina@landing-page-creator-378916.iam.gserviceaccount.com');
          await doc?.loadInfo();
          let sheet;
          sheet = doc?.sheetsByTitle[username];

          if (!sheet) {
            sheet = await doc.addSheet({ title: username, headerValues: ['social_network', 'author', 'message', 'time'] });
          }
          await sheet?.addRow({
            social_network: 'TikTok',
            author: `https://www.tiktok.com/${msg.uniqueId}`,
            message: msg.comment,
            time: new Date().toLocaleString(),
          });
        } catch (error) {
          console.error('Error fetching context from Google Sheet:', JSON.stringify(error));
        }
      }
    });
    tiktokConnectionWrapper.connection.on('gift', (msg) => socket.emit('gift', msg));
    tiktokConnectionWrapper.connection.on('social', (msg) => socket.emit('social', msg));
    // tiktokConnectionWrapper.connection.on('like', msg => socket.emit('like', msg));
    tiktokConnectionWrapper.connection.on('questionNew', (msg) => socket.emit('questionNew', msg));
    tiktokConnectionWrapper.connection.on('linkMicBattle', (msg) => socket.emit('linkMicBattle', msg));
    tiktokConnectionWrapper.connection.on('linkMicArmies', (msg) => socket.emit('linkMicArmies', msg));
    tiktokConnectionWrapper.connection.on('liveIntro', (msg) => socket.emit('liveIntro', msg));
    tiktokConnectionWrapper.connection.on('emote', (msg) => socket.emit('emote', msg));
    tiktokConnectionWrapper.connection.on('envelope', (msg) => socket.emit('envelope', msg));
    tiktokConnectionWrapper.connection.on('subscribe', (msg) => socket.emit('subscribe', msg));
  });

  socket.on('disconnect', () => {
    if (tiktokConnectionWrapper) {
      tiktokConnectionWrapper.disconnect();
    }
  });
});

// Emit global connection statistics
setInterval(() => {
  io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000);

// base auth
app.use((req, res, next) => {
  const auth = { login: process.env.USER, password: process.env.PASS };

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && login === auth.login && password && password === auth.password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Authentication required.');
});

// Serve frontend files
app.use(express.static('public'));

// Start http listener
const port = process.env.PORT || 8081;
httpServer.listen(port);
console.info(`Server running! Please visit http://localhost:${port}`);
