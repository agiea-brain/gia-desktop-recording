const express = require('express');
const axios = require('axios');
const util = require('util');
const app = express();

require('dotenv').config();

// Best-effort Logfire logging for this standalone Node server.
// (This file runs in Node directly, so we avoid ESM-only imports at top-level.)
let logfire = null;
try {
  import('logfire')
    .then((m) => {
      logfire = m;
      if (typeof logfire.configure === 'function') {
        logfire.configure({
          token: process.env.LOGFIRE_TOKEN,
          serviceName: 'gia-server',
          environment: process.env.LOGFIRE_ENVIRONMENT || 'development',
        });
      }
    })
    .catch(() => {
      // ignore
    });
} catch {
  // ignore
}

function log(level, ...args) {
  const msg = util.format(...args);
  try {
    const fn =
      logfire && typeof logfire[level] === 'function'
        ? logfire[level]
        : logfire && typeof logfire.info === 'function'
          ? logfire.info
          : null;
    if (fn) {
      fn(msg, { process: 'server' });
      return;
    }
  } catch {
    // ignore
  }

  // Fallback to stdout/stderr without using console.
  const stream = level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(msg + '\n');
  } catch {
    // ignore
  }
}

// API configuration for Recall.ai
const RECALLAI_API_URL = process.env.RECALLAI_API_URL || 'https://api.recall.ai';
const RECALLAI_API_KEY = process.env.RECALLAI_API_KEY;

app.get('/start-recording', async (req, res) => {
    log('info', `Creating upload token with API key: ${RECALLAI_API_KEY.slice(0,4)}...`);

    if (!RECALLAI_API_KEY) {
        log('error', "RECALLAI_API_KEY is missing! Set it in .env file");
        return res.json({ status: 'error', message: 'RECALLAI_API_KEY is missing' });
    }

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

    try {
        const response = await axios.post(url, {
            recording_config: {
                transcript: {
                    provider: {
                        assembly_ai_v3_streaming: {}
                    }
                },
                realtime_endpoints: [
                    {
                        type: "desktop_sdk_callback",
                        events: [
                            "participant_events.join",
                            "video_separate_png.data",
                            "transcript.data",
                            "transcript.provider_data"
                        ]
                    },
                ],
            }
        }, {
            headers: { 'Authorization': `Token ${RECALLAI_API_KEY}` },
            timeout: 9000,
        });

        res.json({ status: 'success', upload_token: response.data.upload_token });
    } catch (e) {
        log('error', "Error creating upload token:", JSON.stringify(e.errors || e.response?.data || e.message));
        res.json({ status: 'error', message: e.message });
    }
});

if (require.main === module) {
    app.listen(13373, () => {
        log('info', `Server listening on http://localhost:13373`);
    });
}

module.exports = app;
